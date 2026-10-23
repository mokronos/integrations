import { Effect, Option, Ref, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
// The definition alone: importing the package index would pull the server
// — handlers, store, MCP — into every consumer of this client.
import { GatewayApi } from "@integragents/gateway-api/definition"
import {
  Connection,
  GatewayIncompatible,
  GatewayMetadata,
  gatewayProtocolVersion,
  GatewayUnavailable,
  UnexpectedResponse,
  Integration,
  IntegrationDiscovery,
  IntegrationOverview,
  IntegrationSearchResponse,
  IntegrationValidationReport,
  Tool,
  ToolSummary
} from "@integragents/contracts"

export type GatewayCredential =
  /** A client API key, presented as a bearer token. */
  | { readonly apiKey: string }
  /** An operator sign-in, presented as the session cookie the dashboard uses. */
  | { readonly sessionToken: string }

export type GatewayClientOptions = { readonly url: string } & GatewayCredential

const authorize = (options: GatewayClientOptions) =>
  "apiKey" in options
    ? HttpClientRequest.setHeader("authorization", `Bearer ${options.apiKey}`)
    : HttpClientRequest.setHeaders({
        cookie: `integrations_session=${options.sessionToken}`,
        origin: options.url
      })

const decodeGatewayMetadata = Schema.decodeUnknownEffect(GatewayMetadata)

export const readGatewayMetadata = Effect.fn("GatewayClient.readMetadata")(function* (
  url: string
): Effect.fn.Return<
  GatewayMetadata,
  GatewayIncompatible | GatewayUnavailable | UnexpectedResponse,
  HttpClient.HttpClient
> {
  const base = url.replace(/\/+$/, "")
  const metadataUrl = `${base}/v1/metadata`
  const response = yield* HttpClient.get(metadataUrl).pipe(
    Effect.mapError((cause) => new GatewayUnavailable({ url: base, detail: cause.message }))
  )
  if (response.status >= 500) {
    return yield* new GatewayUnavailable({ url: base, detail: `it answered HTTP ${response.status}` })
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* new UnexpectedResponse({ method: "GET", url: metadataUrl, status: response.status })
  }
  const metadata = yield* response.json.pipe(
    Effect.flatMap(decodeGatewayMetadata),
    Effect.mapError(() => new UnexpectedResponse({ method: "GET", url: metadataUrl, status: response.status }))
  )
  if (metadata.protocolVersion !== gatewayProtocolVersion) {
    return yield* new GatewayIncompatible({ expected: gatewayProtocolVersion, received: metadata.protocolVersion })
  }
  return metadata
})

/**
 * The gateway's endpoints, derived from the API definition the gateway serves.
 * Request shapes, response decoding, and the error each route can return all
 * come from that one description rather than being restated here.
 */
export type GatewayEndpoints = Effect.Success<ReturnType<typeof makeEndpoints>>

const makeEndpoints = (
  options: GatewayClientOptions,
  http: HttpClient.HttpClient,
  /**
   * Checked before every call, so a gateway that speaks a protocol we do not
   * is refused before an authenticated request reaches it rather than after.
   * The check is cached, so it costs one request per client, not one per call.
   */
  compatible: Effect.Effect<unknown, GatewayIncompatible | GatewayUnavailable | UnexpectedResponse>
) =>
  HttpApiClient.makeWith(GatewayApi, {
    baseUrl: options.url.replace(/\/+$/, ""),
    httpClient: http.pipe(
      HttpClient.mapRequest(authorize(options)),
      HttpClient.transform((send) => Effect.andThen(compatible, send))
    )
  })

export interface GatewayClient extends GatewayEndpoints {
  readonly url: string
  readonly metadata: Effect.Effect<GatewayMetadata, GatewayIncompatible | GatewayUnavailable | UnexpectedResponse>
  readonly health: Effect.Effect<boolean>
}

export const makeGatewayClient = Effect.fn("GatewayClient.make")(function* (
  options: GatewayClientOptions
): Effect.fn.Return<GatewayClient, never, HttpClient.HttpClient> {
  const http = yield* HttpClient.HttpClient
  const base = options.url.replace(/\/+$/, "")
  // Every call checks the gateway speaks our protocol. Its answer holds for the
  // client's life; a gateway that did not answer is asked again next time.
  const answered = yield* Ref.make(Option.none<Effect.Effect<GatewayMetadata, GatewayIncompatible>>())
  const metadata = Effect.flatMap(Ref.get(answered), (held) =>
    Option.isSome(held)
      ? held.value
      : readGatewayMetadata(base).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.tap((read) => Ref.set(answered, Option.some(Effect.succeed(read)))),
          Effect.tapError((failure) =>
            failure._tag === "GatewayIncompatible" ? Ref.set(answered, Option.some(Effect.fail(failure))) : Effect.void
          )
        )
  )
  const endpoints = yield* makeEndpoints(options, http, metadata)

  return {
    ...endpoints,
    url: base,
    metadata,
    health: Effect.match(metadata, { onFailure: () => false, onSuccess: () => true })
  }
})

export {
  Connection,
  GatewayMetadata,
  gatewayProtocolVersion,
  Integration,
  IntegrationDiscovery,
  IntegrationOverview,
  IntegrationSearchResponse,
  IntegrationValidationReport,
  Tool,
  ToolSummary
}
