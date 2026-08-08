import {
  addExecutorMcp,
  addExecutorOpenApi,
  detectExecutorIntegration,
  findExecutorIntegration,
  previewExecutorOpenApi,
  probeExecutorMcp
} from "./catalog.ts"
import { ensureExecutorConnection } from "./connections.ts"
import type {
  DiscoverIntegrationsOptions,
  IntegrationDiscovery,
  IntegrationInspection
} from "./integration-model.ts"
import type { ExecutorDetection, ExecutorIntegration } from "./schemas.ts"
import { listExecutorTools } from "./tools.ts"

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

const detectWithFallback = async (url: string): Promise<ExecutorDetection> => {
  const detected = bestDetection(await detectExecutorIntegration(url))
  if (detected !== undefined) return detected
  try {
    const probe = await probeExecutorMcp(url)
    return {
      kind: "mcp",
      confidence: "high",
      endpoint: url,
      name: probe.name,
      slug: probe.slug
    }
  } catch {
    const preview = await previewExecutorOpenApi(url)
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
export const inspectIntegration = async (url: string): Promise<IntegrationInspection> => {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported integration URL protocol: ${parsed.protocol}`)
  }
  const normalizedUrl = parsed.toString()
  const detection = await detectWithFallback(normalizedUrl)
  if (detection.kind === "mcp") {
    return {
      url: normalizedUrl,
      detection,
      probe: await probeExecutorMcp(detection.endpoint)
    }
  }
  if (detection.kind === "openapi") {
    return {
      url: normalizedUrl,
      detection,
      preview: await previewExecutorOpenApi(detection.endpoint)
    }
  }
  throw new Error(`Executor detected unsupported integration kind: ${detection.kind}`)
}

/** Installs a previously inspected endpoint in the persisted catalog. */
export const installIntegration = async (
  inspection: IntegrationInspection
): Promise<ExecutorIntegration> => {
  const existing = await findExecutorIntegration(inspection.detection.slug)
  if (existing !== undefined) return existing

  if (inspection.detection.kind === "mcp") {
    const probe = inspection.probe
    if (probe === undefined) throw new Error("MCP installation requires an MCP probe")
    await addExecutorMcp({
      endpoint: inspection.detection.endpoint,
      name: probe.name,
      slug: inspection.detection.slug,
      auth: probe.requiresOAuth ? "oauth2" : probe.requiresAuthentication ? "bearer" : "none"
    })
  } else if (inspection.detection.kind === "openapi") {
    const preview = inspection.preview
    if (preview === undefined) throw new Error("OpenAPI installation requires an OpenAPI preview")
    await addExecutorOpenApi({
      spec: inspection.detection.endpoint,
      slug: inspection.detection.slug,
      name: inspection.detection.name,
      ...(preview.servers[0]?.url === undefined ? {} : { baseUrl: preview.servers[0].url })
    })
  } else {
    throw new Error(`Cannot install unsupported integration kind: ${inspection.detection.kind}`)
  }

  const installed = await findExecutorIntegration(inspection.detection.slug)
  if (installed === undefined) {
    throw new Error(`Executor did not persist integration ${inspection.detection.slug}`)
  }
  return installed
}

/** Compatibility composition for callers that want inspection, installation,
 * default connection policy, and tool listing in one operation. */
export const discoverIntegration = async (
  url: string,
  options: DiscoverIntegrationsOptions = {}
): Promise<IntegrationDiscovery> => {
  const inspection = await inspectIntegration(url)
  const integration = await installIntegration(inspection)
  const connectionName = options.connection ?? "default"
  await ensureExecutorConnection(integration, connectionName)
  return {
    ...inspection,
    integration,
    requiresAuthentication:
      integration.authMethods.length > 0 &&
      !integration.authMethods.some((method) => method.kind === "none"),
    authMethods: integration.authMethods,
    tools: await listExecutorTools({ integration: integration.slug, connection: connectionName })
  }
}
