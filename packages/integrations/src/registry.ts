import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import {
  IntegrationSearchQuery,
  IntegrationSearchResponse,
  IntegrationSearchSurface
} from "@integrations/contracts"
import { describeCause, InvocationError } from "./errors.ts"
import { whenPresent } from "@integrations/contracts"

export {
  IntegrationSearchKind,
  IntegrationSearchMatch,
  IntegrationSearchQuery,
  IntegrationSearchResponse,
  IntegrationSearchSurface
} from "@integrations/contracts"

export interface SearchIntegrationsOptions {
  readonly registryUrl?: string
}

const integrationsRegistryUrl = "https://integrations.sh"

const RegistrySearchResponse = Schema.Struct({
  results: Schema.Array(Schema.Struct({
    domain: Schema.String,
    name: Schema.String,
    description: Schema.String
  }))
})

const RegistrySurface = Schema.Struct({
  type: Schema.Literals(["http", "openapi", "graphql", "mcp", "cli"]),
  slug: Schema.String,
  name: Schema.String,
  url: Schema.optional(Schema.String),
  spec: Schema.optional(Schema.String),
  transports: Schema.optional(Schema.Array(Schema.String)),
  command: Schema.optional(Schema.String)
})
type RegistrySurface = typeof RegistrySurface.Type

const RegistrySurfaceResponse = Schema.Struct({
  surfaces: Schema.Array(RegistrySurface)
})

const decodeSearch = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RegistrySearchResponse)
)
const decodeSurfaces = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RegistrySurfaceResponse)
)
const decodeQuery = Schema.decodeUnknownEffect(IntegrationSearchQuery)

const discoveryUrlFor = (surface: RegistrySurface): string | undefined => {
  switch (surface.type) {
    case "mcp":
      return surface.url
    case "http":
    case "openapi":
      return surface.spec ?? surface.url
    case "graphql":
    case "cli":
      return undefined
  }
}

const toSearchSurface = (surface: RegistrySurface): IntegrationSearchSurface => ({
  type: surface.type,
  slug: surface.slug,
  name: surface.name,
  ...whenPresent("url", discoveryUrlFor(surface)),
  ...whenPresent("transports", surface.transports),
  ...whenPresent("command", surface.command)
})

const fetchText = Effect.fn("registry.fetchText")((url: URL) =>
  HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.mapError((cause) => new InvocationError({
      code: "registry_error",
      detail: describeCause(cause)
    }))
  )
)

const surfacesFor = (registryUrl: string, domain: string) =>
  fetchText(new URL(`/api/${encodeURIComponent(domain)}/surface`, registryUrl)).pipe(
    Effect.flatMap(decodeSurfaces),
    Effect.map((parsed) => parsed.surfaces.map(toSearchSurface)),
    Effect.catch((failure): Effect.Effect<ReadonlyArray<IntegrationSearchSurface>> =>
      Effect.as(
        Effect.logWarning(`Registry could not describe ${domain}: ${failure.message}`).pipe(
          Effect.annotateLogs({ domain, operation: "registry.surfacesFor" })
        ),
        []
      ))
  )

export const search = Effect.fn("registry.search")(function* (
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

  const results = yield* Effect.forEach(
    parsed.results,
    (result) =>
      Effect.map(surfacesFor(registryUrl, result.domain), (surfaces) => ({
        ...result,
        surfaces
      })),
    { concurrency: 8 }
  )
  return { query: text, results } satisfies IntegrationSearchResponse
})

export { search as searchIntegrations }
