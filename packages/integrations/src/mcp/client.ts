import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams
} from "@modelcontextprotocol/sdk/client/auth.js"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { describeCause, McpError } from "../errors.ts"
import { serviceName, slugify } from "@mokronos/contracts"
import { whenPresent } from "@mokronos/contracts"
import { isJsonObject, type Json, type JsonObject } from "@mokronos/contracts"
import { McpProbe } from "@mokronos/contracts"

/** The MCP half of the host, over the official `@modelcontextprotocol/sdk`.
 *
 *  The SDK owns the transports, the JSON-RPC framing, and the initialize
 *  handshake. What lives here is the projection onto this project's shapes and
 *  the decision to resolve credentials ourselves — the transport takes a header
 *  we computed rather than an `authProvider`, because the gateway, not the MCP
 *  client, owns token storage and refresh. */


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
type McpSdkTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number]

const decodeTools = Schema.decodeUnknownEffect(Schema.Array(McpToolDefinition))
const decodeJson = Schema.decodeUnknownEffect(Schema.Json)

/** How a connection authenticates to an MCP endpoint. Resolved before the
 *  transport is built, so the client never needs to know where it came from. */
export interface McpCredential {
  readonly headerName: string
  readonly headerValue: string
}

const requestInit = (credential: Option.Option<McpCredential>): RequestInit =>
  Option.match(credential, {
    onNone: () => ({}),
    onSome: (present) => ({ headers: { [present.headerName]: present.headerValue } })
  })

const clientInfo = { name: "@mokronos/integrations", version: "0.2.0" } as const

/** `tools/call` takes a JSON *object* of arguments or nothing. A tool whose
 *  input schema is an array or a scalar therefore has no arguments to send. */
const callArguments = (input: Json): JsonObject | undefined =>
  isJsonObject(input) ? input : undefined

/** The one place the MCP SDK's types and this project's
 *  `exactOptionalPropertyTypes` disagree.
 *
 *  Both transports declare `sessionId: string | undefined` while the `Transport`
 *  interface declares it `sessionId?: string`, which are incompatible under
 *  that flag. The values are correct at runtime and the mismatch is entirely
 *  upstream's, so it is acknowledged once, here, instead of being cast away at
 *  every call site — and this stops compiling the moment upstream aligns them. */
const attach = (
  client: Client,
  transport: StreamableHTTPClientTransport | SSEClientTransport
): Promise<void> =>
  // @ts-expect-error upstream declares sessionId as `string | undefined`
  // against an optional `string` on Transport.
  client.connect(transport)

/** Streamable HTTP is the current transport; SSE is the deprecated one many
 *  deployed servers still speak. Trying it second costs one failed request and
 *  is the difference between working and not for those servers. */
const connect = (
  endpoint: string,
  credential: Option.Option<McpCredential>
): Effect.Effect<Client, McpError> =>
  Effect.tryPromise({
    try: async () => {
      const url = new URL(endpoint)
      const init = requestInit(credential)
      const client = new Client(clientInfo)
      try {
        await attach(client, new StreamableHTTPClientTransport(url, { requestInit: init }))
        return client
      } catch (streamableCause) {
        const fallback = new Client(clientInfo)
        try {
          await attach(fallback, new SSEClientTransport(url, { requestInit: init }))
          return fallback
        } catch {
          throw streamableCause
        }
      }
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
 *  Google's Gmail endpoint answers `initialize` and `tools/list` to anybody and
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

/** A JSON-RPC `initialize` sent by hand. The SDK would throw on a 401 without
 *  surfacing the challenge headers, and the challenge is the whole point. */
const probeTransport = (endpoint: string): Effect.Effect<Response, McpError> =>
  Effect.tryPromise({
    try: () => fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo
        }
      })
    }),
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
      const listTools = Effect.fn("McpHost.listTools")((
        endpoint: string,
        credential: Option.Option<McpCredential>
      ) =>
        withClient(endpoint, credential, (client) =>
          Effect.tryPromise({
            try: async () => {
              const collected: Array<McpSdkTool> = []
              let cursor: string | undefined
              do {
                const page = await client.listTools(
                  cursor === undefined ? {} : { cursor }
                )
                collected.push(...page.tools)
                cursor = page.nextCursor
              } while (cursor !== undefined)
              return collected
            },
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

      const probe = Effect.fn("McpHost.probe")(function*(endpoint: string) {
        const response = yield* probeTransport(endpoint)
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

        // Reachable without credentials: a real handshake is now cheap and
        // tells us what the server calls itself and how much it exposes.
        const detail = yield* withClient(endpoint, Option.none(), (client) =>
          Effect.tryPromise({
            try: async () => {
              const version = client.getServerVersion()
              const instructions = client.getInstructions()
              const tools = await client.listTools({})
              return {
                serverName: version?.name ?? null,
                instructions: instructions ?? null,
                toolCount: tools.tools.length
              }
            },
            catch: (cause) => new McpError({
              endpoint,
              detail: describeCause(cause),
              cause
            })
          })
        )

        // An anonymous handshake is not a claim that the server is open. Ask it
        // directly, and believe its own metadata over the two methods it let
        // through.
        const authority = yield* inspectAuthority(endpoint, response)
        const serverName = detail.serverName
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
          toolCount: detail.toolCount,
          serverName,
          instructions: detail.instructions
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
