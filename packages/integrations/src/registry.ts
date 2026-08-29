import { Effect, Schema } from "effect"
import {
  IntegrationSearchQuery,
  IntegrationSearchResponse,
  IntegrationSearchSurface
} from "@mokronos/contracts"
import { describeCause, InvocationError } from "./errors.ts"
import { whenPresent } from "@mokronos/contracts"

export {
  IntegrationSearchKind,
  IntegrationSearchMatch,
  IntegrationSearchQuery,
  IntegrationSearchResponse,
  IntegrationSearchSurface
} from "@mokronos/contracts"

/** Searching the public integrations.sh registry.
 *
 *  The one host capability that touches neither the catalog nor a credential: it
 *  asks a public index what exists. Nothing is installed and nothing is stored,
 *  so it needs no service of its own — there is no state to inject and no
 *  alternative implementation to swap in beyond the registry's address. */

export interface SearchIntegrationsOptions {
  readonly registryUrl?: string
}

const integrationsRegistryUrl = "https://integrations.sh"

/** integrations.sh returns a landing page and a redundant `kinds` summary of
 *  the surfaces it is about to list. Neither is actionable, so neither is
 *  decoded. */
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

/** The registry spreads a surface's address over `url` and `spec`; discovery
 *  takes exactly one. */
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

const fetchText = (url: URL) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`)
      }
      return await response.text()
    },
    catch: (cause) => new InvocationError({
      code: "registry_error",
      detail: describeCause(cause)
    })
  })

/** A domain's surfaces. A domain the registry cannot describe contributes no
 *  surfaces rather than failing the whole search: a partial answer is still
 *  useful, and the caller can see which entries have nothing to connect to. */
const surfacesFor = (registryUrl: string, domain: string) =>
  fetchText(new URL(`/api/${encodeURIComponent(domain)}/surface`, registryUrl)).pipe(
    Effect.flatMap(decodeSurfaces),
    Effect.map((parsed) => parsed.surfaces.map(toSearchSurface)),
    Effect.orElseSucceed((): ReadonlyArray<IntegrationSearchSurface> => [])
  )

/** Searches the registry without touching the persisted catalog, connections,
 *  or credentials. */
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

/** The Promise-facing form, for the gateway's HTTP layer. */
export const searchIntegrations = (
  query: IntegrationSearchQuery,
  options: SearchIntegrationsOptions = {}
): Promise<IntegrationSearchResponse> => Effect.runPromise(search(query, options))
