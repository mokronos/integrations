import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import {
  IntegrationSearchQuery,
  IntegrationSearchResponse,
  IntegrationSearchSurface
} from "@mokronos/integrations-contracts"
import { describeCause, InvocationError } from "./errors.ts"
import { whenPresent } from "@mokronos/integrations-contracts"

export {
  IntegrationSearchKind,
  IntegrationSearchMatch,
  IntegrationSearchQuery,
  IntegrationSearchResponse,
  IntegrationSearchSurface
} from "@mokronos/integrations-contracts"

export interface SearchIntegrationsOptions {
  readonly registryUrl?: string
}

const integrationsRegistryUrl = "https://integrations.sh"

const RegistrySearchResponse = Schema.Struct({
  results: Schema.Array(Schema.Struct({
    domain: Schema.String,
    name: Schema.String,
    description: Schema.String,
    surfaces: Schema.Array(Schema.Struct({
      kind: Schema.Literals(["mcp", "openapi", "graphql", "cli"]),
      slug: Schema.String,
      url: Schema.optional(Schema.String)
    }))
  }))
})

const decodeSearch = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RegistrySearchResponse)
)
const decodeQuery = Schema.decodeUnknownEffect(IntegrationSearchQuery)

const toSearchSurface = (surface: typeof RegistrySearchResponse.Type.results[number]["surfaces"][number]): IntegrationSearchSurface => ({
  type: surface.kind,
  slug: surface.slug,
  name: surface.kind === "mcp" ? "MCP" : surface.kind === "openapi" ? "OpenAPI" : surface.kind,
  ...whenPresent("url", surface.url)
})

const fetchText = Effect.fn("Registry.fetchText")((url: URL) =>
  HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.mapError((cause) => new InvocationError({
      code: "registry_error",
      detail: describeCause(cause)
    }))
  )
)

export const search = Effect.fn("Registry.search")(function* (
  query: IntegrationSearchQuery,
  options: SearchIntegrationsOptions = {}
) {
  const decoded = yield* decodeQuery(query).pipe(
    Effect.mapError((cause) => new InvocationError({
      code: "invalid_query",
      detail: describeCause(cause)
    }))
  )
  const text = decoded.q.trim()
  const registryUrl = options.registryUrl ?? integrationsRegistryUrl

  const url = new URL("/api/search", registryUrl)
  url.searchParams.set("q", text)
  if (decoded.kind !== undefined) url.searchParams.set("kind", decoded.kind)
  if (decoded.limit !== undefined) url.searchParams.set("limit", String(decoded.limit))

  const body = yield* fetchText(url)
  const parsed = yield* decodeSearch(body).pipe(
    Effect.mapError((cause) => new InvocationError({
      code: "registry_error",
      detail: `The registry's response was unreadable: ${describeCause(cause)}`
    }))
  )

  const results = parsed.results.map((result) => ({
    domain: result.domain,
    name: result.name,
    description: result.description,
    surfaces: result.surfaces.map(toSearchSurface)
  }))
  return { query: text, results } satisfies IntegrationSearchResponse
})

export { search as searchIntegrations }
