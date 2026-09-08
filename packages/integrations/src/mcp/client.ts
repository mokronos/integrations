import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams
} from "@modelcontextprotocol/client"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { describeCause, McpError } from "../errors.ts"
import { serviceName, slugify } from "@mokronos/contracts"
import { whenPresent } from "@mokronos/contracts"
import { isJsonObject, type Json, type JsonObject } from "@mokronos/contracts"
import { McpProbe } from "@mokronos/contracts"

/** The MCP half of the host, over `@modelcontextprotocol/client`.
 *
 *  The SDK owns the transport, the JSON-RPC framing, and version negotiation.
 *  What lives here is the projection onto this project's shapes and the
 *  decision to resolve credentials ourselves — the transport takes a header we
 *  computed rather than an `authProvider`, because the gateway, not the MCP
 *  client, owns token storage and refresh.
 *
 *  Only protocol revision 2026-07-28 is spoken. That revision has no
 *  `initialize` handshake: every request carries its version in `_meta` and in
 *  the `MCP-Protocol-Version` header, and `server/discover` — which servers
 *  MUST implement — answers identity, capabilities, and supported versions in
 *  one round trip. Nothing here falls back to the 2025 handshake or to the
 *  deprecated HTTP+SSE transport. */

const PROTOCOL_VERSION = "2026-07-28"

const clientInfo = { name: "@mokronos/integrations", version: "0.2.0" } as const

/** The reserved `_meta` keys every modern request carries. The SDK attaches
 *  these itself on a negotiated connection; the discovery probe below is sent
 *  before there is a connection, so it spells them out. */
const requestMeta = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": clientInfo,
  "io.modelcontextprotocol/clientCapabilities": {}
} as const

const McpToolAnnotations = Schema.Struct({
  title: Schema.optional(Schema.String),
  readOnlyHint: Schema.optional(Schema.Boolean),
  destructiveHint: Schema.optional(Schema.Boolean),
  idempotentHint: Schema.optional(Schema.Boolean),
  openWorldHint: Schema.optional(Schema.Boolean)
})
export type McpToolAnnotations = typeof McpToolAnnotations.Type

/** One tool exactly as `tools/list` describes it. Decoded rather than trusted:
 *  the SDK validates the envelope, not each server's idea of a tool. */
export const McpToolDefinition = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json),
  annotations: Schema.optional(McpToolAnnotations)
})
export type McpToolDefinition = typeof McpToolDefinition.Type

const decodeTools = Schema.decodeUnknownEffect(Schema.Array(McpToolDefinition))
const decodeJson = Schema.decodeUnknownEffect(Schema.Json)

/** How a connection authenticates to an MCP endpoint. Resolved before the
 *  transport is built, so the client never needs to know where it came from. */
export interface McpCredential {
  readonly headerName: string
  readonly headerValue: string
}

const credentialHeaders = (
  credential: Option.Option<McpCredential>
): Record<string, string> =>
  Option.match(credential, {
    onNone: () => ({}),
    onSome: (present) => ({ [present.headerName]: present.headerValue })
  })

/** `tools/call` takes a JSON *object* of arguments or nothing. A tool whose
 *  input schema is an array or a scalar therefore has no arguments to send. */
const callArguments = (input: Json): JsonObject | undefined =>
  isJsonObject(input) ? input : undefined

/** One Streamable HTTP connection, pinned to the one revision this host
 *  speaks. `{ pin }` makes the SDK's connect-time `server/discover` mandatory
 *  and refuses to fall back to the 2025 `initialize` sequence, so a server that
 *  only speaks the legacy era fails loudly here rather than half-working. */
const connect = (
  endpoint: string,
  credential: Option.Option<McpCredential>
): Effect.Effect<Client, McpError> =>
  Effect.tryPromise({
    try: async () => {
      const client = new Client(clientInfo, {
        versionNegotiation: { mode: { pin: PROTOCOL_VERSION } }
      })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(endpoint), {
          requestInit: { headers: credentialHeaders(credential) }
        })
      )
      return client
    },
    catch: (cause) => new McpError({
      endpoint,
      detail: describeCause(cause),
      cause
    })
  })

/** Brackets a client so a failed call still closes its transport. */
const withClient = <A, E>(
  endpoint: string,
  credential: Option.Option<McpCredential>,
  use: (client: Client) => Effect.Effect<A, E>
): Effect.Effect<A, E | McpError> =>
  Effect.acquireUseRelease(
    connect(endpoint, credential),
    use,
    (client) => Effect.promise(() => client.close().catch(() => undefined))
  )

const AuthorizationServerMetadata = Schema.Struct({
  registration_endpoint: Schema.optional(Schema.String)
})

const ProtectedResourceMetadata = Schema.Struct({
  authorization_servers: Schema.optional(Schema.Array(Schema.String)),
  scopes_supported: Schema.optional(Schema.Array(Schema.String))
})

/** An OAuth authority the endpoint pointed us at, and what it will accept. */
interface McpAuthority {
  readonly supportsDynamicRegistration: boolean
  readonly scopes: ReadonlyArray<string>
}

/** The OAuth authority an endpoint names for itself, when it names one.
 *
 *  RFC 9728 metadata is published unconditionally, not only behind a challenge,
 *  and reading it only after a 401 misses the servers that most need it read.
 *  Google's Gmail endpoint answers discovery and `tools/list` to anybody and
 *  refuses every `tools/call`; it declares its authorization server and scopes
 *  the whole time. Taking the anonymous handshake as the answer files it as
 *  needing no credential, which is true of exactly the two methods nobody
 *  connects an integration in order to use.
 *
 *  `None` means the endpoint published no metadata — not that it is open. What
 *  an unexplained refusal implies is the caller's to decide. */
const inspectAuthority = (
  endpoint: string,
  response: Response
): Effect.Effect<Option.Option<McpAuthority>> =>
  Effect.promise(async () => {
    // Absent on a 200, present on a challenge that names its metadata: either
    // way this is a hint, and discovery has its own path convention to fall
    // back on.
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(response)
    try {
      const discovered = await discoverOAuthProtectedResourceMetadata(
        endpoint,
        resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }
      )
      const resource = Schema.decodeUnknownOption(ProtectedResourceMetadata)(discovered)
      const authorizationServer = Option.flatMap(
        resource,
        (found) => Option.fromNullishOr(found.authorization_servers?.[0])
      )
      const metadata = await discoverAuthorizationServerMetadata(
        Option.getOrElse(authorizationServer, () => endpoint)
      )
      const server = Schema.decodeUnknownOption(AuthorizationServerMetadata)(metadata)
      return Option.some({
        supportsDynamicRegistration: Option.match(server, {
          onNone: () => false,
          onSome: (found) => found.registration_endpoint !== undefined
        }),
        // Carried from here rather than rediscovered at authorization time,
        // because a provider without dynamic registration sends the operator to
        // a console to enter these by hand before any flow starts.
        scopes: Option.match(resource, {
          onNone: (): ReadonlyArray<string> => [],
          onSome: (found) => found.scopes_supported ?? []
        })
      })
    } catch {
      return Option.none()
    }
  })

const ServerInfo = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String)
})

/** Only the capabilities this host acts on. A server may declare more. */
const ServerCapabilities = Schema.Struct({
  tools: Schema.optional(Schema.Struct({
    listChanged: Schema.optional(Schema.Boolean)
  }))
})

const DiscoverResult = Schema.Struct({
  supportedVersions: Schema.Array(Schema.String),
  capabilities: ServerCapabilities,
  instructions: Schema.optional(Schema.String),
  _meta: Schema.optional(Schema.Struct({
    "io.modelcontextprotocol/serverInfo": Schema.optional(ServerInfo)
  }))
})
type DiscoverResult = typeof DiscoverResult.Type

const JsonRpcError = Schema.Struct({
  code: Schema.Number,
  message: Schema.optional(Schema.String)
})

/** A JSON-RPC response to `server/discover`: a result, or an error naming why. */
const DiscoverResponse = Schema.Struct({
  result: Schema.optional(DiscoverResult),
  error: Schema.optional(JsonRpcError)
})

const decodeDiscoverResponse = Schema.decodeUnknownEffect(DiscoverResponse)

/** Error codes only a server that speaks the modern protocol emits. Seeing one
 *  is positive evidence of MCP even though the request itself failed — the
 *  spec's own backward-compatibility rule turns on exactly this distinction. */
const MODERN_ERROR_CODES: ReadonlyArray<number> = [
  -32022, // UnsupportedProtocolVersion
  -32021, // MissingRequiredClientCapability
  -32020 //  HeaderMismatch
]

/** A request may be answered with a single JSON object or with an SSE stream
 *  carrying the response as its final event; clients MUST support both. */
const readBody = async (response: Response): Promise<Json> => {
  const body = await response.text()
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body)
  }
  const payloads = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
  const last = payloads[payloads.length - 1]
  if (last === undefined) throw new Error("the event stream carried no data")
  return JSON.parse(last)
}

/** `server/discover` sent by hand, before there is a client.
 *
 *  The SDK would throw on a 401 without surfacing the challenge headers, and
 *  the challenge is what names the authorization server. Sending discovery
 *  rather than a tool listing is also what makes this a valid identity check:
 *  a `DiscoverResult` — or a refusal carrying a modern error code — is the
 *  spec's own evidence that an endpoint speaks MCP. */
const probeDiscovery = (
  endpoint: string
): Effect.Effect<{ readonly response: Response; readonly body: Json }, McpError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": PROTOCOL_VERSION,
          "Mcp-Method": "server/discover"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: { _meta: requestMeta }
        })
      })
      // A challenge has no body worth reading, and reading it would consume the
      // response the caller needs for `WWW-Authenticate`.
      if (response.status === 401 || response.status === 403) {
        return { response, body: null }
      }
      return { response, body: await readBody(response) }
    },
    catch: (cause) => new McpError({
      endpoint,
      detail: describeCause(cause),
      cause
    })
  })

/** What to call a server that did not say. The host is all there is to go on,
 *  and the whole host names a URL rather than a vendor. */
const fallbackName = (endpoint: string): string => {
  const parsed = Option.getOrUndefined(
    Option.liftThrowable(() => new URL(endpoint))()
  )
  return parsed === undefined ? endpoint : serviceName(parsed.hostname)
}

export class McpHost extends Context.Service<
  McpHost,
  {
    /** Reads an endpoint without installing anything or storing a credential. */
    readonly probe: (endpoint: string) => Effect.Effect<McpProbe, McpError>
    readonly listTools: (
      endpoint: string,
      credential: Option.Option<McpCredential>
    ) => Effect.Effect<ReadonlyArray<McpToolDefinition>, McpError>
    /** Returns the raw `tools/call` envelope; normalising it is the tool
     *  layer's job, because OpenAPI results need the same treatment. */
    readonly callTool: (
      endpoint: string,
      credential: Option.Option<McpCredential>,
      tool: string,
      input: Json
    ) => Effect.Effect<Json, McpError>
  }
>()("@mokronos/integrations/McpHost") {
  static readonly layer: Layer.Layer<McpHost> = Layer.effect(
    McpHost,
    Effect.sync(() => {
      /** `listTools()` with no cursor walks every page itself, and answers with
       *  an empty list when the server declares no `tools` capability — so a
       *  resources-only server lists nothing rather than failing. */
      const listTools = Effect.fn("McpHost.listTools")((
        endpoint: string,
        credential: Option.Option<McpCredential>
      ) =>
        withClient(endpoint, credential, (client) =>
          Effect.tryPromise({
            try: async () => (await client.listTools()).tools,
            catch: (cause) => new McpError({
              endpoint,
              detail: `tools/list failed: ${describeCause(cause)}`,
              cause
            })
          }).pipe(
            Effect.flatMap((tools) =>
              decodeTools(tools).pipe(Effect.mapError((cause) =>
                new McpError({
                  endpoint,
                  detail: "tools/list returned an unreadable tool",
                  cause
                })
              ))
            )
          ))
      )

      /** How many tools a server that declares them actually exposes. A server
       *  declaring no `tools` capability exposes none, and is not asked. */
      const countTools = Effect.fn("McpHost.countTools")(function*(
        endpoint: string,
        capabilities: typeof ServerCapabilities.Type
      ) {
        if (capabilities.tools === undefined) return 0
        const tools = yield* listTools(endpoint, Option.none())
        return tools.length
      })

      const probe = Effect.fn("McpHost.probe")(function*(endpoint: string) {
        const { response, body } = yield* probeDiscovery(endpoint)
        const name = fallbackName(endpoint)
        const slug = Option.getOrElse(slugify(name), () => "mcp")

        if (response.status === 401 || response.status === 403) {
          const authority = yield* inspectAuthority(endpoint, response)
          return yield* Schema.decodeUnknownEffect(McpProbe)({
            connected: false,
            requiresAuthentication: true,
            requiresOAuth: Option.isSome(authority),
            supportsDynamicRegistration: Option.match(authority, {
              onNone: () => false,
              onSome: (found) => found.supportsDynamicRegistration
            }),
            // No metadata behind the refusal: the wall is real but not an OAuth
            // one this host can drive, so a bearer token is what is left to
            // offer.
            scopes: Option.match(authority, {
              onNone: (): ReadonlyArray<string> => [],
              onSome: (found) => found.scopes
            }),
            name,
            slug,
            toolCount: null,
            serverName: null,
            instructions: null
          }).pipe(Effect.mapError((cause) =>
            new McpError({ endpoint, detail: "Could not describe probe", cause })
          ))
        }

        const answered = yield* decodeDiscoverResponse(body).pipe(
          Effect.mapError((cause) =>
            new McpError({
              endpoint,
              detail: "it did not answer server/discover with a JSON-RPC response",
              cause
            })
          )
        )

        if (answered.result === undefined) {
          // A modern error code proves the endpoint speaks MCP — it just does
          // not speak this revision. Saying so beats reporting "not an MCP
          // endpoint", which would send the caller looking for the wrong fault.
          const code = answered.error?.code
          return yield* new McpError({
            endpoint,
            detail: code !== undefined && MODERN_ERROR_CODES.includes(code)
              ? `it speaks MCP but not protocol revision ${PROTOCOL_VERSION} ` +
                `(${answered.error?.message ?? `error ${code}`})`
              : `it refused server/discover (${answered.error?.message ?? "no result"})`
          })
        }

        const discovered = answered.result
        if (!discovered.supportedVersions.includes(PROTOCOL_VERSION)) {
          return yield* new McpError({
            endpoint,
            detail: `it supports protocol revisions ${discovered.supportedVersions.join(", ")}, ` +
              `and this host speaks only ${PROTOCOL_VERSION}`
          })
        }

        const toolCount = yield* countTools(endpoint, discovered.capabilities)

        // An anonymous handshake is not a claim that the server is open. Ask it
        // directly, and believe its own metadata over the methods it let
        // through.
        const authority = yield* inspectAuthority(endpoint, response)
        const serverName = discovered._meta?.["io.modelcontextprotocol/serverInfo"]?.name ?? null
        return yield* Schema.decodeUnknownEffect(McpProbe)({
          connected: true,
          requiresAuthentication: Option.isSome(authority),
          requiresOAuth: Option.isSome(authority),
          supportsDynamicRegistration: Option.match(authority, {
            onNone: () => false,
            onSome: (found) => found.supportsDynamicRegistration
          }),
          scopes: Option.match(authority, {
            onNone: (): ReadonlyArray<string> => [],
            onSome: (found) => found.scopes
          }),
          name: serverName ?? name,
          slug: serverName === null
            ? slug
            : Option.getOrElse(slugify(serverName), () => slug),
          toolCount,
          serverName,
          instructions: discovered.instructions ?? null
        }).pipe(Effect.mapError((cause) =>
          new McpError({ endpoint, detail: "Could not describe probe", cause })
        ))
      })

      const callTool = Effect.fn("McpHost.callTool")((
        endpoint: string,
        credential: Option.Option<McpCredential>,
        tool: string,
        input: Json
      ) =>
        withClient(endpoint, credential, (client) =>
          Effect.tryPromise({
            try: () => client.callTool({
              name: tool,
              ...whenPresent("arguments", callArguments(input))
            }),
            catch: (cause) => new McpError({
              endpoint,
              detail: `tools/call ${tool} failed: ${describeCause(cause)}`,
              cause
            })
          }).pipe(
            Effect.flatMap((result) =>
              decodeJson(result).pipe(Effect.mapError((cause) =>
                new McpError({
                  endpoint,
                  detail: `tools/call ${tool} returned a non-JSON result`,
                  cause
                })
              ))
            )
          ))
      )

      return { probe, listTools, callTool }
    })
  )
}
