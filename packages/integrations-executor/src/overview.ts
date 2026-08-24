import { whenPresent } from "./optional.ts"
import { requiresAuthentication } from "./auth-templates.ts"
import type { ExecutorCatalog, ExecutorConnections, ExecutorTools } from "./executor-services.ts"
import type { ExecutorTool, IntegrationOverview } from "./schemas.ts"

export interface IntegrationOverviewDependencies {
  readonly catalog: Pick<ExecutorCatalog, "list">
  readonly connections: Pick<ExecutorConnections, "list">
  readonly tools: Pick<ExecutorTools, "list">
}

const toolsForConnection = async (
  integration: string,
  connection: string,
  tools: Pick<ExecutorTools, "list">
): Promise<{ readonly tools: ReadonlyArray<ExecutorTool>; readonly error?: string }> => {
  try {
    return { tools: await tools.list({ integration, connection }) }
  } catch (cause) {
    return {
      tools: [],
      error: `${connection}: ${cause instanceof Error ? cause.message : String(cause)}`
    }
  }
}

/** The full picture of what is connected: every catalog integration with its
 *  connections and the tools each connection exposes.
 *
 *  Listing tools reaches the live endpoint, so one failing integration reports
 *  a `toolError` rather than failing the whole page. */
export const createIntegrationOverview = (
  dependencies: IntegrationOverviewDependencies
) => async (): Promise<ReadonlyArray<IntegrationOverview>> => {
  const [integrations, connections] = await Promise.all([
    dependencies.catalog.list(),
    dependencies.connections.list()
  ])
  const overviews = await Promise.all(integrations.map(async (integration) => {
    const owned = connections.filter((connection) => connection.integration === integration.slug)
    const listings = await Promise.all(owned.map((connection) =>
      toolsForConnection(integration.slug, connection.name, dependencies.tools)
    ))
    const errors = listings.flatMap((listing) => listing.error === undefined ? [] : [listing.error])
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
