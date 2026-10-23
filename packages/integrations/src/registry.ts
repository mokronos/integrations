import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import {
  IntegrationSearchQuery,
  IntegrationSearchResponse,
  IntegrationSearchSurface,
  InvalidInput,
  RegistryUnavailable
} from "@integragents/contracts"
import { whenPresent } from "@integragents/contracts"

export {
  IntegrationSearchKind,
  IntegrationSearchMatch,
  IntegrationSearchQuery,
  IntegrationSearchResponse,
  IntegrationSearchSurface
} from "@integragents/contracts"

export interface SearchIntegrationsOptions {
  readonly registryUrl?: string
}

const integrationsRegistryUrl = "https://integrations.sh"

const RegistrySurface = Schema.Struct({
  kind: Schema.Literals(["mcp", "openapi", "graphql", "cli"]),
  slug: Schema.String,
  url: Schema.optional(Schema.String)
})

const RegistrySearchResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      domain: Schema.String,
      name: Schema.String,
      description: Schema.String,
      surfaces: Schema.optional(Schema.Array(RegistrySurface))
    })
  )
})

const decodeSearch = Schema.decodeUnknownEffect(Schema.fromJsonString(RegistrySearchResponse))
const decodeQuery = Schema.decodeUnknownEffect(IntegrationSearchQuery)

const toSearchSurface = (surface: typeof RegistrySurface.Type): IntegrationSearchSurface => ({
  type: surface.kind,
  slug: surface.slug,
  name: surface.kind === "mcp" ? "MCP" : surface.kind === "openapi" ? "OpenAPI" : surface.kind,
  ...whenPresent("url", surface.url)
})

const fetchText = Effect.fn("Registry.fetchText")((url: URL) =>
  HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.mapError((failure) =>
      failure.reason._tag === "StatusCodeError"
        ? new RegistryUnavailable({ reason: "status", status: failure.reason.response.status })
        : failure.reason._tag === "TransportError"
          ? new RegistryUnavailable({ reason: "unreachable" })
          : new RegistryUnavailable({ reason: "unreadable" })
    )
  )
)

export const search = Effect.fn("Registry.search")(function* (
  query: IntegrationSearchQuery,
  options: SearchIntegrationsOptions = {}
) {
  const decoded = yield* decodeQuery(query).pipe(
    Effect.mapError((failure) => InvalidInput.fromSchemaError("query", failure))
  )
  const text = decoded.q.trim()
  const registryUrl = options.registryUrl ?? integrationsRegistryUrl

  const url = new URL("/api/search", registryUrl)
  url.searchParams.set("q", text)
  if (decoded.kind !== undefined) url.searchParams.set("kind", decoded.kind)
  if (decoded.limit !== undefined) url.searchParams.set("limit", String(decoded.limit))

  const body = yield* fetchText(url)
  const parsed = yield* decodeSearch(body).pipe(
    Effect.mapError(() => new RegistryUnavailable({ reason: "unreadable" }))
  )

  const results = parsed.results.flatMap((result) =>
    result.surfaces === undefined || result.surfaces.length === 0
      ? []
      : [
          {
            domain: result.domain,
            name: result.name,
            description: result.description,
            surfaces: result.surfaces.map(toSearchSurface)
          }
        ]
  )
  return { query: text, results } satisfies IntegrationSearchResponse
})

export { search as searchIntegrations }
