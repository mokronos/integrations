import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams
} from "@modelcontextprotocol/client"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http"
import type { Headers } from "effect/unstable/http"
import { describeCause, McpError } from "../errors.ts"
import { serviceName, slugify } from "@integrations/contracts"
import { whenPresent } from "@integrations/contracts"
import { isJsonObject, parseJsonString, type Json, type JsonObject } from "@integrations/contracts"
import { McpProbe } from "@integrations/contracts"

const PROTOCOL_VERSION = "2026-07-28"

const clientInfo = { name: "@integrations/integrations", version: "0.2.0" } as const

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

const callArguments = (input: Json): JsonObject | undefined =>
  isJsonObject(input) ? input : undefined

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

interface McpAuthority {
  readonly supportsDynamicRegistration: boolean
  readonly scopes: ReadonlyArray<string>
}

const inspectAuthority = (
  endpoint: string,
  headers: Headers.Headers
): Effect.Effect<Option.Option<McpAuthority>> =>
  Effect.promise(async () => {
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(
      new Response(null, { headers: { ...headers } })
    )
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

const DiscoverResponse = Schema.Struct({
  result: Schema.optional(DiscoverResult),
  error: Schema.optional(JsonRpcError)
})

const decodeDiscoverResponse = Schema.decodeUnknownEffect(DiscoverResponse)

const MODERN_ERROR_CODES: ReadonlyArray<number> = [
  -32022,
  -32021,
  -32020
]

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

export class McpClient extends Context.Service<
  McpClient,
  {
    readonly probe: (endpoint: string) => Effect.Effect<McpProbe, McpError>
    readonly listTools: (
      endpoint: string,
      credential: Option.Option<McpCredential>
    ) => Effect.Effect<ReadonlyArray<McpToolDefinition>, McpError>
    readonly callTool: (
      endpoint: string,
      credential: Option.Option<McpCredential>,
      tool: string,
      input: Json
    ) => Effect.Effect<Json, McpError>
  }
>()("@integrations/integrations/McpClient") {
  static readonly layer: Layer.Layer<McpClient, never, HttpClient.HttpClient> = Layer.effect(
    McpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      const listTools = Effect.fn("McpClient.listTools")((
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

      const countTools = Effect.fn("McpClient.countTools")(function*(
        endpoint: string,
        capabilities: typeof ServerCapabilities.Type
      ) {
        if (capabilities.tools === undefined) return 0
        const tools = yield* listTools(endpoint, Option.none())
        return tools.length
      })

      const probe = Effect.fn("McpClient.probe")(function*(endpoint: string) {
        const { response, body } = yield* probeDiscovery(client, endpoint)
        const name = fallbackName(endpoint)
        const slug = Option.getOrElse(slugify(name), () => "mcp")

        if (response.status === 401 || response.status === 403) {
          const authority = yield* inspectAuthority(endpoint, response.headers)
          return yield* Schema.decodeUnknownEffect(McpProbe)({
            connected: false,
            requiresAuthentication: true,
            requiresOAuth: Option.isSome(authority),
            supportsDynamicRegistration: Option.match(authority, {
              onNone: () => false,
              onSome: (found) => found.supportsDynamicRegistration
            }),
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

        const authority = yield* inspectAuthority(endpoint, response.headers)
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

      const callTool = Effect.fn("McpClient.callTool")((
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
