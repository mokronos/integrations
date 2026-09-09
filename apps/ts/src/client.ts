import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
// The definition alone: importing the package index would pull the server
// — handlers, store, MCP — into every consumer of this client.
import { GatewayApi } from "@integrations/gateway-api/definition"
import {
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
} from "@integrations/contracts"

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
      cookie: `wf_session=${options.sessionToken}`,
      origin: options.url
    })

export class GatewayProtocolError extends Error {
  readonly expected: number
  readonly received: number | undefined

  constructor(received: number | undefined, detail?: string) {
    const actual = received === undefined ? "missing" : String(received)
    super(
      `Incompatible gateway protocol: client requires ${gatewayProtocolVersion}, gateway reported ${actual}` +
        (detail === undefined ? "" : ` (${detail})`)
    )
    this.name = "GatewayProtocolError"
    this.expected = gatewayProtocolVersion
    this.received = received
  }
}

const decodeGatewayMetadata = Schema.decodeUnknownEffect(GatewayMetadata)

export const readGatewayMetadata = Effect.fn("GatewayClient.readMetadata")(function*(
  url: string
): Effect.fn.Return<GatewayMetadata, GatewayProtocolError, HttpClient.HttpClient> {
  const response = yield* HttpClient.get(`${url.replace(/\/+$/, "")}/v1/metadata`).pipe(
    Effect.mapError((cause) =>
      new GatewayProtocolError(undefined, `metadata could not be read: ${cause.message}`)
    )
  )
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(
      new GatewayProtocolError(undefined, `metadata returned HTTP ${response.status}`)
    )
  }
  const metadata = yield* response.json.pipe(
    Effect.flatMap(decodeGatewayMetadata),
    Effect.mapError(() => new GatewayProtocolError(undefined, "gateway metadata is malformed"))
  )
  if (metadata.protocolVersion !== gatewayProtocolVersion) {
    return yield* Effect.fail(
      new GatewayProtocolError(metadata.protocolVersion, `gateway ${metadata.gatewayVersion}`)
    )
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
  compatible: Effect.Effect<unknown, GatewayProtocolError>
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
  readonly metadata: Effect.Effect<GatewayMetadata, GatewayProtocolError>
  readonly health: Effect.Effect<boolean>
}

export const makeGatewayClient = Effect.fn("GatewayClient.make")(function*(
  options: GatewayClientOptions
): Effect.fn.Return<GatewayClient, never, HttpClient.HttpClient> {
  const http = yield* HttpClient.HttpClient
  const base = options.url.replace(/\/+$/, "")
  // Read once and share: every call checks the gateway speaks our protocol,
  // and the answer does not change while a client is alive.
  const metadata = yield* Effect.cached(
    readGatewayMetadata(base).pipe(Effect.provideService(HttpClient.HttpClient, http))
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
