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
import { slugify } from "@mokronos/contracts"
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

/** What an unauthenticated request tells us about the wall in front of the
 *  endpoint. A 401 alone only says "credentials needed"; whether OAuth is on
 *  offer, and whether a client can register itself, comes from the metadata the
 *  challenge points at. */
const inspectAuthWall = (
  endpoint: string,
  response: Response
): Effect.Effect<{
  readonly requiresOAuth: boolean
  readonly supportsDynamicRegistration: boolean
}> =>
  Effect.promise(async () => {
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(response)
    try {
      const resource = await discoverOAuthProtectedResourceMetadata(
        endpoint,
        resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }
      )
      const authorizationServer = resource.authorization_servers?.[0] ?? endpoint
      const metadata = await discoverAuthorizationServerMetadata(authorizationServer)
      const decoded = Schema.decodeUnknownOption(AuthorizationServerMetadata)(metadata)
      return {
        requiresOAuth: true,
        supportsDynamicRegistration: Option.match(decoded, {
          onNone: () => false,
          onSome: (server) => server.registration_endpoint !== undefined
        })
      }
    } catch {
      // No RFC 9728 metadata: the wall is real but it is not an OAuth one we
      // can drive, so a bearer token is the only thing left to offer.
      return { requiresOAuth: false, supportsDynamicRegistration: false }
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

const fallbackName = (endpoint: string): string => {
  const parsed = Option.getOrUndefined(
    Option.liftThrowable(() => new URL(endpoint))()
  )
  return parsed?.hostname ?? endpoint
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
          const wall = yield* inspectAuthWall(endpoint, response)
          return yield* Schema.decodeUnknownEffect(McpProbe)({
            connected: false,
            requiresAuthentication: true,
            requiresOAuth: wall.requiresOAuth,
            supportsDynamicRegistration: wall.supportsDynamicRegistration,
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

        const serverName = detail.serverName
        return yield* Schema.decodeUnknownEffect(McpProbe)({
          connected: true,
          requiresAuthentication: false,
          requiresOAuth: false,
          supportsDynamicRegistration: false,
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
