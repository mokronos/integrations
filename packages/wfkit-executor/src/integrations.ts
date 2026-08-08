import { Schema } from "effect"
import {
  listExecutorConnections,
  listExecutorIntegrations,
  listExecutorTools
} from "./executor.ts"
import {
  ExecutorTool,
  IntegrationOverview
} from "./schemas.ts"
import {
  IntegrationNodeConfig,
  type IntegrationValidationFinding,
  type IntegrationValidationReport
} from "./integration-model.ts"
export {
  IntegrationDiscovery,
  IntegrationInspection,
  IntegrationKind,
  IntegrationNodeConfig,
  IntegrationValidationFinding,
  IntegrationValidationReport
} from "./integration-model.ts"
export type {
  DiscoverIntegrationsOptions
} from "./integration-model.ts"
export { discoverIntegration, inspectIntegration, installIntegration } from "./discovery.ts"

const toolsForConnection = async (
  integration: string,
  connection: string
): Promise<{ readonly tools: ReadonlyArray<ExecutorTool>; readonly error?: string }> => {
  try {
    return { tools: await listExecutorTools({ integration, connection }) }
  } catch (cause) {
    return {
      tools: [],
      error: `${connection}: ${cause instanceof Error ? cause.message : String(cause)}`
    }
  }
}

/** The full picture of what is connected: every catalog integration with its
 *  connections and the tools each connection exposes. Listing tools reaches the
 *  live endpoint, so a failing integration reports `toolError` instead of
 *  failing the whole overview. */
export const listIntegrationOverviews = async (): Promise<ReadonlyArray<IntegrationOverview>> => {
  const [integrations, connections] = await Promise.all([
    listExecutorIntegrations(),
    listExecutorConnections()
  ])
  const overviews = await Promise.all(integrations.map(async (integration) => {
    const owned = connections.filter((connection) => connection.integration === integration.slug)
    const listings = await Promise.all(owned.map((connection) =>
      toolsForConnection(integration.slug, connection.name)
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
      ...(integration.displayUrl === undefined ? {} : { displayUrl: integration.displayUrl }),
      requiresAuthentication: integration.authMethods.length > 0 &&
        !integration.authMethods.some((method) => method.kind === "none"),
      authMethods: integration.authMethods,
      connections: owned,
      tools,
      ...(errors.length === 0 ? {} : { toolError: errors.join("; ") })
    }
  }))
  return overviews.toSorted((left, right) => left.name.localeCompare(right.name))
}

const finding = (
  severity: IntegrationValidationFinding["severity"],
  check: string,
  message: string
): IntegrationValidationFinding => ({ severity, check, message })

export const validateIntegrationNode = async (
  config: Schema.Schema.Type<typeof Schema.Json>,
  options: { readonly live?: boolean } = {}
): Promise<IntegrationValidationReport> => {
  let node: IntegrationNodeConfig
  try {
    node = await Schema.decodeUnknownPromise(IntegrationNodeConfig)(config)
  } catch (error) {
    return {
      ok: false,
      findings: [finding("error", "structural", `invalid integration node: ${String(error)}`)]
    }
  }
  const findings: Array<IntegrationValidationFinding> = [
    finding("info", "structural", "Executor tool address is valid")
  ]
  if (options.live === true) {
    const tool = (await listExecutorTools()).find((candidate) =>
      candidate.address === node.source.address
    )
    if (tool === undefined) {
      findings.push(finding("error", "catalog", `Executor tool not found: ${node.source.address}`))
    } else {
      findings.push(finding("info", "catalog", `${tool.name} is available`))
    }
  }
  return {
    ok: !findings.some((entry) => entry.severity === "error"),
    findings
  }
}
