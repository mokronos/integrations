import { Schema } from "effect"
import {
  IntegrationSearchQuery,
  IntegrationSearchResponse,
  IntegrationSearchSurface
} from "@mokronos/integrations-protocol/registry"
import { whenPresent } from "./optional.ts"

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

/** integrations.sh returns a registry landing page and a redundant `kinds`
 * summary of the surfaces it is about to list. Neither is actionable, so
 * neither is decoded. */
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

/** The registry spreads a surface's address over `url` and `spec`; discover
 * takes exactly one. */
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
    return parsed.surfaces.map(toSearchSurface)
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
