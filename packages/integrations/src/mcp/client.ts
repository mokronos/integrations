import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { VersionNegotiationMode } from "@modelcontextprotocol/client"
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams
} from "@modelcontextprotocol/client"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http"
import type { Headers } from "effect/unstable/http"
import { describeCause, McpError } from "../errors.ts"
import { serviceName, slugify } from "@mokronos/integrations-contracts"
import { whenPresent } from "@mokronos/integrations-contracts"
import { isJsonObject, parseJsonString, type Json, type JsonObject } from "@mokronos/integrations-contracts"
import { McpEra, McpProbe } from "@mokronos/integrations-contracts"

const PROTOCOL_VERSION = "2026-07-28"

const clientInfo = { name: "@mokronos/integrations-host", version: "0.2.0" } as const

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

export interface McpServer {
  readonly endpoint: string
  readonly era: Option.Option<McpEra>
}

export interface McpToolListing {
  readonly tools: ReadonlyArray<McpToolDefinition>
  readonly era: McpEra
}

const negotiation = (era: Option.Option<McpEra>): VersionNegotiationMode =>
  Option.match(era, {
    onNone: () => "auto",
    onSome: (known) => known === "modern" ? { pin: PROTOCOL_VERSION } : "legacy"
  })

const callArguments = (input: Json): JsonObject | undefined =>
  isJsonObject(input) ? input : undefined

const connect = (
  server: McpServer,
  credential: Option.Option<McpCredential>
): Effect.Effect<Client, McpError> =>
  Effect.tryPromise({
    try: async () => {
      const client = new Client(clientInfo, {
        versionNegotiation: { mode: negotiation(server.era) }
      })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.endpoint), {
          requestInit: { headers: credentialHeaders(credential) }
        })
      )
      return client
    },
    catch: (cause) => new McpError({
      endpoint: server.endpoint,
      detail: describeCause(cause),
      cause
    })
  })

const withClient = <A, E>(
  server: McpServer,
  credential: Option.Option<McpCredential>,
  use: (client: Client) => Effect.Effect<A, E>
): Effect.Effect<A, E | McpError> =>
  Effect.acquireUseRelease(
    connect(server, credential),
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

interface McpAuthority {
  readonly supportsDynamicRegistration: boolean
  readonly scopes: ReadonlyArray<string>
}

const resourceMetadataUrlOf = (headers: Headers.Headers): Option.Option<URL> =>
  Option.fromNullishOr(
    extractWWWAuthenticateParams(new Response(null, { headers: { ...headers } })).resourceMetadataUrl
  )

const inspectAuthority = (
  endpoint: string,
  resourceMetadataUrl: Option.Option<URL>
): Effect.Effect<Option.Option<McpAuthority>> =>
  Effect.promise(async () => {
    try {
      const discovered = await discoverOAuthProtectedResourceMetadata(
        endpoint,
        Option.match(resourceMetadataUrl, {
          onNone: () => ({}),
          onSome: (url) => ({ resourceMetadataUrl: url })
        })
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

const DiscoverResult = Schema.Struct({
  supportedVersions: Schema.Array(Schema.String),
  instructions: Schema.optional(Schema.String),
  _meta: Schema.optional(Schema.Struct({
    "io.modelcontextprotocol/serverInfo": Schema.optional(ServerInfo)
  }))
})

const JsonRpcError = Schema.Struct({
  code: Schema.Number,
  message: Schema.optional(Schema.String)
})

const DiscoverResponse = Schema.Struct({
  result: Schema.optional(DiscoverResult),
  error: Schema.optional(JsonRpcError)
})

const decodeDiscoverResponse = Schema.decodeUnknownEffect(DiscoverResponse)

const lastEventData = (body: string): Option.Option<string> =>
  Option.fromNullishOr(
    body
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .pop()
  )

const readBody = (
  endpoint: string,
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<Json, McpError> =>
  response.text.pipe(
    Effect.mapError((cause) =>
      new McpError({ endpoint, detail: describeCause(cause), cause })
    ),
    Effect.flatMap((text) => {
      const payload = response.headers["content-type"]?.includes("text/event-stream") === true
        ? lastEventData(text)
        : Option.some(text)
      return Option.match(Option.flatMap(payload, parseJsonString), {
        onNone: () => Effect.fail(new McpError({
          endpoint,
          detail: "it answered server/discover with something other than JSON"
        })),
        onSome: Effect.succeed
      })
    })
  )

const probeDiscovery = (
  client: HttpClient.HttpClient,
  endpoint: string
): Effect.Effect<
  { readonly response: HttpClientResponse.HttpClientResponse; readonly body: Json },
  McpError
> =>
  client.post(endpoint, {
    headers: {
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      "Mcp-Method": "server/discover"
    },
    body: HttpBody.jsonUnsafe({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: requestMeta }
    })
  }).pipe(
    Effect.mapError((cause) =>
      new McpError({ endpoint, detail: describeCause(cause), cause })
    ),
    Effect.flatMap((response) =>
      response.status === 401 || response.status === 403
        ? Effect.succeed({ response, body: null })
        : Effect.map(readBody(endpoint, response), (body) => ({ response, body }))
    )
  )

const fallbackName = (endpoint: string): string => {
  const parsed = Option.getOrUndefined(
    Option.liftThrowable(() => new URL(endpoint))()
  )
  return parsed === undefined ? endpoint : serviceName(parsed.hostname)
}

const describeProbe = (endpoint: string, probe: McpProbe) =>
  Schema.decodeUnknownEffect(McpProbe)(probe).pipe(Effect.mapError((cause) =>
    new McpError({ endpoint, detail: "Could not describe probe", cause })
  ))

const authorityFields = (authority: Option.Option<McpAuthority>) => ({
  requiresOAuth: Option.isSome(authority),
  supportsDynamicRegistration: Option.match(authority, {
    onNone: () => false,
    onSome: (found) => found.supportsDynamicRegistration
  }),
  scopes: Option.match(authority, {
    onNone: (): ReadonlyArray<string> => [],
    onSome: (found) => found.scopes
  })
})

const decodeEra = (endpoint: string, client: Client) =>
  Schema.decodeUnknownEffect(McpEra)(client.getProtocolEra()).pipe(Effect.mapError((cause) =>
    new McpError({ endpoint, detail: "the session negotiated no protocol era", cause })
  ))

export class McpClient extends Context.Service<
  McpClient,
  {
    readonly probe: (endpoint: string) => Effect.Effect<McpProbe, McpError>
    readonly listTools: (
      server: McpServer,
      credential: Option.Option<McpCredential>
    ) => Effect.Effect<McpToolListing, McpError>
    readonly callTool: (
      server: McpServer,
      credential: Option.Option<McpCredential>,
      tool: string,
      input: Json
    ) => Effect.Effect<Json, McpError>
  }
>()("@mokronos/integrations-host/McpClient") {
  static readonly layer: Layer.Layer<McpClient, never, HttpClient.HttpClient> = Layer.effect(
    McpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      const listTools = Effect.fn("McpClient.listTools")((
        server: McpServer,
        credential: Option.Option<McpCredential>
      ) =>
        withClient(server, credential, (session) =>
          Effect.gen(function*() {
            const era = yield* decodeEra(server.endpoint, session)
            const listed = yield* Effect.tryPromise({
              try: async () => (await session.listTools()).tools,
              catch: (cause) => new McpError({
                endpoint: server.endpoint,
                detail: `tools/list failed: ${describeCause(cause)}`,
                cause
              })
            })
            const tools = yield* decodeTools(listed).pipe(Effect.mapError((cause) =>
              new McpError({
                endpoint: server.endpoint,
                detail: "tools/list returned an unreadable tool",
                cause
              })
            ))
            return { tools, era }
          }))
      )

      /**
       * Older servers do not answer `server/discover`, so a legacy session is
       * the only way they describe themselves.
       */
      const describeLegacySession = (endpoint: string) =>
        withClient({ endpoint, era: Option.some("legacy") }, Option.none(), (session) =>
          Effect.sync(() => ({
            serverName: session.getServerVersion()?.name ?? null,
            instructions: session.getInstructions() ?? null
          })))

      const probe = Effect.fn("McpClient.probe")(function*(endpoint: string) {
        const [{ response, body }, ambientAuthority] = yield* Effect.all([
          probeDiscovery(client, endpoint),
          inspectAuthority(endpoint, Option.none())
        ], { concurrency: "unbounded" })
        const name = fallbackName(endpoint)
        const slug = Option.getOrElse(slugify(name), () => "mcp")

        if (response.status === 401 || response.status === 403) {
          const declared = resourceMetadataUrlOf(response.headers)
          const authority = Option.isSome(declared)
            ? yield* inspectAuthority(endpoint, declared)
            : ambientAuthority
          return yield* describeProbe(endpoint, {
            connected: false,
            requiresAuthentication: true,
            ...authorityFields(authority),
            name,
            slug,
            era: null,
            serverName: null,
            instructions: null
          })
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

        const modern = answered.result !== undefined &&
          answered.result.supportedVersions.includes(PROTOCOL_VERSION)
        const described = modern
          ? {
            serverName: answered.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name ?? null,
            instructions: answered.result?.instructions ?? null
          }
          : yield* describeLegacySession(endpoint)

        return yield* describeProbe(endpoint, {
          connected: true,
          requiresAuthentication: Option.isSome(ambientAuthority),
          ...authorityFields(ambientAuthority),
          name: described.serverName ?? name,
          slug: described.serverName === null
            ? slug
            : Option.getOrElse(slugify(described.serverName), () => slug),
          era: modern ? "modern" : "legacy",
          serverName: described.serverName,
          instructions: described.instructions
        })
      })

      const callTool = Effect.fn("McpClient.callTool")((
        server: McpServer,
        credential: Option.Option<McpCredential>,
        tool: string,
        input: Json
      ) =>
        withClient(server, credential, (client) =>
          Effect.tryPromise({
            try: () => client.callTool({
              name: tool,
              ...whenPresent("arguments", callArguments(input))
            }),
            catch: (cause) => new McpError({
              endpoint: server.endpoint,
              detail: `tools/call ${tool} failed: ${describeCause(cause)}`,
              cause
            })
          }).pipe(
            Effect.flatMap((result) =>
              decodeJson(result).pipe(Effect.mapError((cause) =>
                new McpError({
                  endpoint: server.endpoint,
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
