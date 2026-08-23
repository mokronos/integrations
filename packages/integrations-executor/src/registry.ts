import { Schema } from "effect"
import {
  IntegrationSearchKind,
  IntegrationSearchQuery,
  IntegrationSearchResponse,
  IntegrationSearchSurface
} from "@mokronos/integrations-protocol/registry"

export {
  IntegrationSearchKind,
  IntegrationSearchMatch,
  IntegrationSearchQuery,
  IntegrationSearchResponse,
  IntegrationSearchSurface
} from "@mokronos/integrations-protocol/registry"

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
  const decodedQuery = Schema.decodeUnknownSync(IntegrationSearchQuery)(query)
  const text = decodedQuery.q.trim()

  const registryUrl = options.registryUrl ?? integrationsRegistryUrl
  const url = new URL("/api/search", registryUrl)
  url.searchParams.set("q", text)
  if (decodedQuery.kind !== undefined) url.searchParams.set("kind", decodedQuery.kind)
  if (decodedQuery.limit !== undefined) url.searchParams.set("limit", String(decodedQuery.limit))

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
