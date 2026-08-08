import { Schema } from "effect"

export const IntegrationSearchKind = Schema.Literals(["mcp", "openapi", "graphql", "cli"])
export type IntegrationSearchKind = typeof IntegrationSearchKind.Type

export const IntegrationSearchQuery = Schema.Struct({
  q: Schema.String,
  kind: Schema.optional(IntegrationSearchKind),
  limit: Schema.optional(Schema.Int)
})
export type IntegrationSearchQuery = typeof IntegrationSearchQuery.Type

export const IntegrationSearchSurface = Schema.Struct({
  type: Schema.Literals(["http", "openapi", "graphql", "mcp", "cli"]),
  slug: Schema.String,
  name: Schema.String,
  url: Schema.optional(Schema.String),
  spec: Schema.optional(Schema.String),
  transports: Schema.optional(Schema.Array(Schema.String)),
  command: Schema.optional(Schema.String),
  discoveryUrl: Schema.optional(Schema.String)
})
export type IntegrationSearchSurface = typeof IntegrationSearchSurface.Type

export const IntegrationSearchMatch = Schema.Struct({
  domain: Schema.String,
  name: Schema.String,
  description: Schema.String,
  kinds: Schema.Array(IntegrationSearchKind),
  url: Schema.String,
  surfaces: Schema.Array(IntegrationSearchSurface)
})
export type IntegrationSearchMatch = typeof IntegrationSearchMatch.Type

export const IntegrationSearchResponse = Schema.Struct({
  query: Schema.String,
  results: Schema.Array(IntegrationSearchMatch)
})
export type IntegrationSearchResponse = typeof IntegrationSearchResponse.Type

export interface SearchIntegrationsOptions {
  readonly registryUrl?: string
}

const integrationsRegistryUrl = "https://integrations.sh"

const RegistrySearchResponse = Schema.Struct({
  results: Schema.Array(Schema.Struct({
    domain: Schema.String,
    name: Schema.String,
    description: Schema.String,
    kinds: Schema.Array(IntegrationSearchKind),
    url: Schema.String
  }))
})

const RegistrySurfaceResponse = Schema.Struct({
  surfaces: Schema.Array(IntegrationSearchSurface)
})

const discoveryUrlFor = (surface: IntegrationSearchSurface): string | undefined => {
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

const searchSurface = async (
  registryUrl: string,
  domain: string
): Promise<ReadonlyArray<IntegrationSearchSurface>> => {
  try {
    const url = new URL(`/api/${encodeURIComponent(domain)}/surface`, registryUrl)
    const response = await fetch(url)
    if (!response.ok) return []
    const parsed = await Schema.decodeUnknownPromise(
      Schema.fromJsonString(RegistrySurfaceResponse)
    )(await response.text())
    return parsed.surfaces.map((surface) => {
      const discoveryUrl = discoveryUrlFor(surface)
      return discoveryUrl === undefined ? surface : { ...surface, discoveryUrl }
    })
  } catch {
    return []
  }
}

/** Searches the public integrations.sh registry without touching Executor's
 * persisted catalog, connections, or credentials. */
export const searchIntegrations = async (
  query: IntegrationSearchQuery,
  options: SearchIntegrationsOptions = {}
): Promise<IntegrationSearchResponse> => {
  const text = query.q.trim()
  if (text.length === 0) throw new Error("Integration search query cannot be empty")
  if (query.limit !== undefined && (query.limit < 1 || query.limit > 100)) {
    throw new Error("Integration search limit must be between 1 and 100")
  }

  const registryUrl = options.registryUrl ?? integrationsRegistryUrl
  const url = new URL("/api/search", registryUrl)
  url.searchParams.set("q", text)
  if (query.kind !== undefined) url.searchParams.set("kind", query.kind)
  if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit))

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Integration search failed: ${response.status} ${response.statusText}`)
  }
  const parsed = await Schema.decodeUnknownPromise(
    Schema.fromJsonString(RegistrySearchResponse)
  )(await response.text())
  const results = await Promise.all(parsed.results.map(async (result) => ({
    ...result,
    surfaces: await searchSurface(registryUrl, result.domain)
  })))
  return { query: text, results }
}
