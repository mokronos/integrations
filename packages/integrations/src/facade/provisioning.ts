import { Schema } from "effect"
import { requiresAuthentication } from "../catalog/auth-methods.ts"
import type {
  CatalogApi,
  ConnectionsApi,
  ToolsApi
} from "./api.ts"
import {
  EndpointClassification,
  type DiscoverIntegrationsOptions,
  type IntegrationDiscovery
} from "@mokronos/contracts"
import type { Integration } from "@mokronos/contracts"

/** Turning a URL into an installed integration.
 *
 *  Classification says what the endpoint is; this makes it permanent: install
 *  it in the catalog, make sure a connection exists, and list what that
 *  connection exposes. */

export interface IntegrationProvisioningDependencies {
  readonly catalog: Pick<CatalogApi, "classify" | "addMcp" | "addOpenApi" | "find">
  readonly connections: Pick<ConnectionsApi, "ensure">
  readonly tools: Pick<ToolsApi, "list">
}

const installWith = async (
  classification: EndpointClassification,
  dependencies: IntegrationProvisioningDependencies
): Promise<Integration> => {
  const decoded = Schema.decodeUnknownSync(EndpointClassification)(classification)
  const existing = await dependencies.catalog.find(decoded.slug)
  if (existing !== undefined) return existing

  // The auth method is never passed in: installing re-probes the endpoint and
  // derives it from how the server actually refuses, so a caller cannot record
  // a method the server does not offer.
  if (decoded.kind === "mcp") {
    await dependencies.catalog.addMcp({
      endpoint: decoded.endpoint,
      name: decoded.name,
      slug: decoded.slug
    })
  } else {
    await dependencies.catalog.addOpenApi({
      spec: decoded.endpoint,
      slug: decoded.slug,
      name: decoded.name
    })
  }

  const installed = await dependencies.catalog.find(decoded.slug)
  if (installed === undefined) {
    throw new Error(`The catalog did not persist integration ${decoded.slug}`)
  }
  return installed
}

const provisionWith = async (
  url: string,
  options: DiscoverIntegrationsOptions,
  dependencies: IntegrationProvisioningDependencies
): Promise<IntegrationDiscovery> => {
  const classification = await dependencies.catalog.classify(url)
  const integration = await installWith(classification, dependencies)
  const connectionName = options.connection ?? "default"
  const connected = await dependencies.connections.ensure(integration, connectionName)
  return {
    url,
    classification,
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
  install: (classification: EndpointClassification) =>
    installWith(classification, dependencies),
  provision: (url: string, options: DiscoverIntegrationsOptions = {}) =>
    provisionWith(url, options, dependencies)
})
