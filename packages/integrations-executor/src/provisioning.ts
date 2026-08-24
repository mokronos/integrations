import { whenPresent } from "./optional.ts"
import { Schema } from "effect"
import { requiresAuthentication } from "./auth-templates.ts"
import type { createIntegrationDiscovery } from "./discovery.ts"
import type {
  ExecutorCatalog,
  ExecutorConnections,
  ExecutorTools
} from "./executor-services.ts"
import {
  IntegrationInspection,
  type DiscoverIntegrationsOptions,
  type IntegrationDiscovery
} from "./integration-model.ts"
import type { ExecutorIntegration } from "./schemas.ts"

export interface IntegrationProvisioningDependencies {
  readonly discovery: ReturnType<typeof createIntegrationDiscovery>
  readonly catalog: Pick<ExecutorCatalog, "addMcp" | "addOpenApi" | "find">
  readonly connections: Pick<ExecutorConnections, "ensure">
  readonly tools: Pick<ExecutorTools, "list">
}

const installWith = async (
  inspection: IntegrationInspection,
  dependencies: IntegrationProvisioningDependencies
): Promise<ExecutorIntegration> => {
  const decoded = Schema.decodeUnknownSync(IntegrationInspection)(inspection)
  const existing = await dependencies.catalog.find(decoded.detection.slug)
  if (existing !== undefined) return existing

  if ("probe" in decoded) {
    const probe = decoded.probe
    // The auth method is no longer passed in: installing re-probes the
    // endpoint and derives it from how the server actually refuses, so a caller
    // cannot record a method the server does not offer.
    await dependencies.catalog.addMcp({
      endpoint: decoded.detection.endpoint,
      name: probe.name,
      slug: decoded.detection.slug
    })
  } else {
    const preview = decoded.preview
    await dependencies.catalog.addOpenApi({
      spec: decoded.detection.endpoint,
      slug: decoded.detection.slug,
      name: decoded.detection.name,
      ...whenPresent("description", preview.description)
    })
  }

  const installed = await dependencies.catalog.find(decoded.detection.slug)
  if (installed === undefined) {
    throw new Error(`The catalog did not persist integration ${decoded.detection.slug}`)
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
    requiresAuthentication: requiresAuthentication(integration.authMethods),
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

