import {
  addExecutorMcp,
  addExecutorOpenApi,
  detectExecutorIntegration,
  findExecutorIntegration,
  previewExecutorOpenApi,
  probeExecutorMcp
} from "./catalog.ts"
import { ensureExecutorConnection } from "./connections.ts"
import type { ExecutorCatalog } from "./catalog.ts"
import type { ExecutorConnections } from "./connections.ts"
import type {
  DiscoverIntegrationsOptions,
  IntegrationDiscovery,
  IntegrationInspection
} from "./integration-model.ts"
import type { ExecutorDetection, ExecutorIntegration } from "./schemas.ts"
import { listExecutorTools } from "./tools.ts"
import type { ExecutorTools } from "./tools.ts"

export interface IntegrationDiscoveryDependencies {
  readonly catalog: Pick<
    ExecutorCatalog,
    "detectIntegration" | "probeMcp" | "previewOpenApi" | "addMcp" | "addOpenApi" | "find"
  >
  readonly connections: Pick<ExecutorConnections, "ensure">
  readonly tools: Pick<ExecutorTools, "list">
}

const defaultDependencies: IntegrationDiscoveryDependencies = {
  catalog: {
    detectIntegration: detectExecutorIntegration,
    probeMcp: probeExecutorMcp,
    previewOpenApi: previewExecutorOpenApi,
    addMcp: addExecutorMcp,
    addOpenApi: addExecutorOpenApi,
    find: findExecutorIntegration
  },
  connections: { ensure: ensureExecutorConnection },
  tools: { list: listExecutorTools }
}

const confidenceRank = (confidence: ExecutorDetection["confidence"]): number => {
  switch (confidence) {
    case "high": return 3
    case "medium": return 2
    case "low": return 1
  }
}

const bestDetection = (detections: ReadonlyArray<ExecutorDetection>): ExecutorDetection | undefined =>
  [...detections].sort((left, right) =>
    confidenceRank(right.confidence) - confidenceRank(left.confidence)
  )[0]

const detectWithFallback = async (
  url: string,
  dependencies: IntegrationDiscoveryDependencies
): Promise<ExecutorDetection> => {
  const detected = bestDetection(await dependencies.catalog.detectIntegration(url))
  if (detected !== undefined) return detected
  try {
    const probe = await dependencies.catalog.probeMcp(url)
    return {
      kind: "mcp",
      confidence: "high",
      endpoint: url,
      name: probe.name,
      slug: probe.slug
    }
  } catch {
    const preview = await dependencies.catalog.previewOpenApi(url)
    const name = preview.title ?? new URL(url).hostname
    return {
      kind: "openapi",
      confidence: "high",
      endpoint: url,
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
    }
  }
}

/** Detects and probes an endpoint without changing persisted Executor state. */
const inspectWith = async (
  url: string,
  dependencies: IntegrationDiscoveryDependencies
): Promise<IntegrationInspection> => {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported integration URL protocol: ${parsed.protocol}`)
  }
  const normalizedUrl = parsed.toString()
  const detection = await detectWithFallback(normalizedUrl, dependencies)
  if (detection.kind === "mcp") {
    return {
      url: normalizedUrl,
      detection,
      probe: await dependencies.catalog.probeMcp(detection.endpoint)
    }
  }
  if (detection.kind === "openapi") {
    return {
      url: normalizedUrl,
      detection,
      preview: await dependencies.catalog.previewOpenApi(detection.endpoint)
    }
  }
  throw new Error(`Executor detected unsupported integration kind: ${detection.kind}`)
}

/** Installs a previously inspected endpoint in the persisted catalog. */
const installWith = async (
  inspection: IntegrationInspection,
  dependencies: IntegrationDiscoveryDependencies
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

/** Compatibility composition for callers that want inspection, installation,
 * default connection policy, and tool listing in one operation. */
const discoverWith = async (
  url: string,
  options: DiscoverIntegrationsOptions,
  dependencies: IntegrationDiscoveryDependencies
): Promise<IntegrationDiscovery> => {
  const inspection = await inspectWith(url, dependencies)
  const integration = await installWith(inspection, dependencies)
  const connectionName = options.connection ?? "default"
  await dependencies.connections.ensure(integration, connectionName)
  return {
    ...inspection,
    integration,
    requiresAuthentication:
      integration.authMethods.length > 0 &&
      !integration.authMethods.some((method) => method.kind === "none"),
    authMethods: integration.authMethods,
    tools: await dependencies.tools.list({ integration: integration.slug, connection: connectionName })
  }
}

export const createIntegrationDiscovery = (
  dependencies: IntegrationDiscoveryDependencies
) => ({
  inspect: (url: string) => inspectWith(url, dependencies),
  install: (inspection: IntegrationInspection) => installWith(inspection, dependencies),
  discover: (url: string, options: DiscoverIntegrationsOptions = {}) =>
    discoverWith(url, options, dependencies)
})

const defaultDiscovery = createIntegrationDiscovery(defaultDependencies)

/** Detects and probes an endpoint without changing persisted Executor state. */
export const inspectIntegration = defaultDiscovery.inspect

/** Installs a previously inspected endpoint in the persisted catalog. */
export const installIntegration = defaultDiscovery.install

/** Compatibility composition for inspection, installation, connection policy,
 * and tool listing. */
export const discoverIntegration = defaultDiscovery.discover
