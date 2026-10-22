import type { FetchLike } from "@modelcontextprotocol/client"
import { Effect, Option, Schema } from "effect"
import { HttpBody, HttpClient, HttpClientResponse } from "effect/http"
import { McpError } from "../errors.ts"
import type { Protocol } from "../oauth/protocol.ts"
import { hostOf, refusedDestination, transportCode } from "../unreachable.ts"
import { serviceName, slugify } from "@integragents/contracts"
import { parseJsonString, type Json } from "@integragents/contracts"
import { McpProbe } from "@integragents/contracts"
import { asMcpError, failure, httpFailure, PROTOCOL_VERSION, requestMeta, withClient } from "./session.ts"

interface McpAuthority {
  readonly supportsDynamicRegistration: boolean
  readonly scopes: ReadonlyArray<string>
}

/** The authorization server the endpoint names, the way a connection will discover it. */
const inspectAuthority = (protocol: Protocol, endpoint: string): Effect.Effect<Option.Option<McpAuthority>> =>
  protocol.discoverServer(endpoint).pipe(
    Effect.map((found) =>
      Option.some({
        supportsDynamicRegistration: found.server.registration_endpoint !== undefined,
        scopes:
          Option.getOrUndefined(found.challenge)?.scopes ??
          Option.getOrUndefined(found.resource)?.scopes_supported ??
          []
      })
    ),
    Effect.orElseSucceed(() => Option.none<McpAuthority>())
  )

const ServerInfo = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String)
})

const DiscoverResult = Schema.Struct({
  supportedVersions: Schema.Array(Schema.String),
  instructions: Schema.optional(Schema.String),
  _meta: Schema.optional(
    Schema.Struct({
      "io.modelcontextprotocol/serverInfo": Schema.optional(ServerInfo)
    })
  )
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

const unreachable = (endpoint: string, cause: unknown) =>
  asMcpError(
    endpoint,
    Option.none()
  )(
    Option.match(refusedDestination(cause), {
      onNone: () => failure("network", `could not reach ${hostOf(endpoint)}`, { diagnostic: transportCode(cause) }),
      onSome: (refused) => failure("network", refused.message)
    })
  )

const readBody = (endpoint: string, response: HttpClientResponse.HttpClientResponse): Effect.Effect<Json, McpError> =>
  response.text.pipe(
    Effect.catch((cause) => unreachable(endpoint, cause)),
    Effect.flatMap((text) => {
      const payload =
        response.headers["content-type"]?.includes("text/event-stream") === true
          ? lastEventData(text)
          : Option.some(text)
      return Option.match(Option.flatMap(payload, parseJsonString), {
        onNone: () =>
          Effect.fail(
            new McpError({
              endpoint,
              reason: "protocol",
              detail: "it answered server/discover with something other than JSON",
              status: response.status
            })
          ),
        onSome: Effect.succeed
      })
    })
  )

type Discovery =
  | { readonly kind: "auth"; readonly response: HttpClientResponse.HttpClientResponse }
  | { readonly kind: "no-streamable-http" }
  | { readonly kind: "answered"; readonly body: Json }

const probeDiscovery = (client: HttpClient.HttpClient, endpoint: string): Effect.Effect<Discovery, McpError> =>
  client
    .post(endpoint, {
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
    })
    .pipe(
      Effect.catch((cause) => unreachable(endpoint, cause)),
      Effect.flatMap((response): Effect.Effect<Discovery, McpError> => {
        if (response.status === 401 || response.status === 403) return Effect.succeed({ kind: "auth", response })
        if (response.status === 404 || response.status === 405) return Effect.succeed({ kind: "no-streamable-http" })
        if (response.status === 429 || response.status >= 500) {
          const failed = httpFailure(response.status, new globalThis.Headers(response.headers), Option.none())
          return asMcpError(endpoint, Option.some("server/discover"))(failed)
        }
        return Effect.map(readBody(endpoint, response), (body) => ({ kind: "answered", body }))
      })
    )

const fallbackName = (endpoint: string): string => {
  const parsed = Option.getOrUndefined(Option.liftThrowable(() => new URL(endpoint))())
  return parsed === undefined ? endpoint : serviceName(parsed.hostname)
}

const describeProbe = (endpoint: string, probe: McpProbe) =>
  Schema.decodeUnknownEffect(McpProbe)(probe).pipe(
    Effect.mapError(
      (cause) => new McpError({ endpoint, reason: "protocol", detail: "Could not describe probe", cause })
    )
  )

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

/**
 * Older servers do not answer `server/discover`, so a legacy session is
 * the only way they describe themselves.
 */
const describeLegacySession = (send: FetchLike, endpoint: string) =>
  withClient(send, { endpoint, era: Option.some("legacy") }, Option.none(), (session) =>
    Effect.sync(() => ({
      serverName: session.client.getServerVersion()?.name ?? null,
      instructions: session.client.getInstructions() ?? null
    }))
  )

/** What an endpoint says about itself before any credential is attached. */
export const probeServer = (client: HttpClient.HttpClient, protocol: Protocol, send: FetchLike) =>
  Effect.fnUntraced(function* (endpoint: string) {
    const [discovery, ambientAuthority] = yield* Effect.all(
      [probeDiscovery(client, endpoint), inspectAuthority(protocol, endpoint)],
      { concurrency: "unbounded" }
    )
    const name = fallbackName(endpoint)
    const slug = Option.getOrElse(slugify(name), () => "mcp")

    if (discovery.kind === "auth") {
      return yield* describeProbe(endpoint, {
        connected: false,
        requiresAuthentication: true,
        ...authorityFields(ambientAuthority),
        name,
        slug,
        era: null,
        serverName: null,
        instructions: null
      })
    }

    const answered =
      discovery.kind === "answered"
        ? yield* decodeDiscoverResponse(discovery.body).pipe(
            Effect.mapError(
              (cause) =>
                new McpError({
                  endpoint,
                  reason: "protocol",
                  detail: "it did not answer server/discover with a JSON-RPC response",
                  cause
                })
            )
          )
        : { result: undefined }

    const modern = answered.result !== undefined && answered.result.supportedVersions.includes(PROTOCOL_VERSION)
    const described = modern
      ? {
          serverName: answered.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name ?? null,
          instructions: answered.result?.instructions ?? null
        }
      : yield* describeLegacySession(send, endpoint)

    return yield* describeProbe(endpoint, {
      connected: true,
      requiresAuthentication: Option.isSome(ambientAuthority),
      ...authorityFields(ambientAuthority),
      name: described.serverName ?? name,
      slug: described.serverName === null ? slug : Option.getOrElse(slugify(described.serverName), () => slug),
      era: modern ? "modern" : "legacy",
      serverName: described.serverName,
      instructions: described.instructions
    })
  })
