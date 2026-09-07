import { Effect } from "effect"
import { whenPresent } from "@mokronos/contracts"
import { requiresAuthentication } from "./catalog/auth-methods.ts"
import { IntegrationHost } from "./host.ts"
import type { StorageError } from "./errors.ts"
import type { IntegrationOverview, Tool } from "@mokronos/contracts"

/** One connection's tools, or why they could not be read. */
interface ConnectionTools {
  readonly tools: ReadonlyArray<Tool>
  readonly error?: string
}

/** The full picture of what is connected: every catalog integration with its
 *  connections and the tools each connection exposes.
 *
 *  One integration whose tools cannot be read reports a `toolError` rather than
 *  failing the whole page — a catalog is mostly still useful with one entry
 *  broken. The failure is carried in the answer instead of being swallowed. */
export const listIntegrationOverviews = Effect.fn("Integrations.listOverviews")(
  function*(): Effect.fn.Return<ReadonlyArray<IntegrationOverview>, StorageError, IntegrationHost> {
    const host = yield* IntegrationHost
    const [integrations, connections] = yield* Effect.all([
      host.listIntegrations(),
      host.listConnections()
    ])
    const overviews = yield* Effect.forEach(integrations, (integration) =>
      Effect.gen(function*() {
        const owned = connections.filter((connection) =>
          connection.integration === integration.slug
        )
        const listings = yield* Effect.forEach(owned, (connection) =>
          host.listTools({
            integration: integration.slug,
            connection: connection.name
          }).pipe(
            Effect.map((tools): ConnectionTools => ({ tools })),
            Effect.catch((failure): Effect.Effect<ConnectionTools> =>
              Effect.succeed({
                tools: [],
                error: `${connection.name}: ${failure.message}`
              })
            )
          ))
        const errors = listings.flatMap((listing) =>
          listing.error === undefined ? [] : [listing.error]
        )
        const tools = listings
          .flatMap((listing) => listing.tools)
          .toSorted((left, right) => left.name.localeCompare(right.name))
        return {
          slug: integration.slug,
          name: integration.name,
          description: integration.description,
          kind: integration.kind,
          ...whenPresent("displayUrl", integration.displayUrl),
          requiresAuthentication: requiresAuthentication(integration.authMethods),
          authMethods: integration.authMethods,
          connections: owned,
          tools,
          ...whenPresent("toolError", errors.length === 0 ? undefined : errors.join("; "))
        }
      }))
    return overviews.toSorted((left, right) => left.name.localeCompare(right.name))
  }
)
