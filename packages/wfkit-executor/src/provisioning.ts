import {
  addExecutorMcp,
  addExecutorOpenApi,
  findExecutorIntegration
} from "./catalog.ts"
import type { ExecutorCatalog } from "./catalog.ts"
import { ensureExecutorConnection } from "./connections.ts"
import type { ExecutorConnections } from "./connections.ts"
import { createIntegrationDiscovery, inspectIntegration } from "./discovery.ts"
import type {
  DiscoverIntegrationsOptions,
  IntegrationDiscovery,
  IntegrationInspection
} from "./integration-model.ts"
import type { ExecutorIntegration } from "./schemas.ts"
import { listExecutorTools } from "./tools.ts"
import type { ExecutorTools } from "./tools.ts"

export interface IntegrationProvisioningDependencies {
  readonly discovery: ReturnType<typeof createIntegrationDiscovery>
  readonly catalog: Pick<ExecutorCatalog, "addMcp" | "addOpenApi" | "find">
  readonly connections: Pick<ExecutorConnections, "ensure">
  readonly tools: Pick<ExecutorTools, "list">
}

const defaultDependencies: IntegrationProvisioningDependencies = {
  discovery: { inspect: inspectIntegration },
  catalog: {
    addMcp: addExecutorMcp,
    addOpenApi: addExecutorOpenApi,
    find: findExecutorIntegration
  },
  connections: { ensure: ensureExecutorConnection },
  tools: { list: listExecutorTools }
}

const installWith = async (
  inspection: IntegrationInspection,
  dependencies: IntegrationProvisioningDependencies
): Promise<ExecutorIntegration> => {
  const existing = await dependencies.catalog.find(inspection.detection.slug)
  if (existing !== undefined) return existing

  if (inspection.detection.kind === "mcp") {
    const probe = inspection.probe
    if (probe === undefined) throw new Error("MCP installation requires an MCP probe")
    await dependencies.catalog.addMcp({
      endpoint: inspection.detection.endpoint,
      name: probe.name,
      slug: inspection.detection.slug,
      auth: probe.requiresOAuth ? "oauth2" : probe.requiresAuthentication ? "bearer" : "none"
    })
  } else if (inspection.detection.kind === "openapi") {
    const preview = inspection.preview
    if (preview === undefined) throw new Error("OpenAPI installation requires an OpenAPI preview")
    await dependencies.catalog.addOpenApi({
      spec: inspection.detection.endpoint,
      slug: inspection.detection.slug,
      name: inspection.detection.name,
      ...(preview.servers[0]?.url === undefined ? {} : { baseUrl: preview.servers[0].url })
    })
  } else {
    throw new Error(`Cannot install unsupported integration kind: ${inspection.detection.kind}`)
  }

  const installed = await dependencies.catalog.find(inspection.detection.slug)
  if (installed === undefined) {
    throw new Error(`Executor did not persist integration ${inspection.detection.slug}`)
  }
  return installed
}

const provisionWith = async (
  url: string,
  options: DiscoverIntegrationsOptions,
  dependencies: IntegrationProvisioningDependencies
): Promise<IntegrationDiscovery> => {
  const inspection = await dependencies.discovery.inspect(url)
  const integration = await installWith(inspection, dependencies)
  const connectionName = options.connection ?? "default"
  const connected = await dependencies.connections.ensure(integration, connectionName)
  return {
    ...inspection,
    integration,
    requiresAuthentication:
      integration.authMethods.length > 0 &&
      !integration.authMethods.some((method) => method.kind === "none"),
    authMethods: integration.authMethods,
    tools: connected
      ? await dependencies.tools.list({ integration: integration.slug, connection: connectionName })
      : []
  }
}

export const createIntegrationProvisioning = (
  dependencies: IntegrationProvisioningDependencies
) => ({
  install: (inspection: IntegrationInspection) => installWith(inspection, dependencies),
  provision: (url: string, options: DiscoverIntegrationsOptions = {}) =>
    provisionWith(url, options, dependencies)
})

const defaultProvisioning = createIntegrationProvisioning(defaultDependencies)

export const installIntegration = defaultProvisioning.install

/** Compatibility name for the original inspect-install-connect-list operation. */
export const discoverIntegration = defaultProvisioning.provision
