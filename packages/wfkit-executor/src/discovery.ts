import {
  detectExecutorIntegration,
  previewExecutorOpenApi,
  probeExecutorMcp
} from "./catalog.ts"
import type { ExecutorCatalog } from "./catalog.ts"
import type { IntegrationInspection } from "./integration-model.ts"
import type { ExecutorDetection } from "./schemas.ts"

export interface IntegrationDiscoveryDependencies {
  readonly catalog: Pick<
    ExecutorCatalog,
    "detectIntegration" | "probeMcp" | "previewOpenApi"
  >
}

const defaultDependencies: IntegrationDiscoveryDependencies = {
  catalog: {
    detectIntegration: detectExecutorIntegration,
    probeMcp: probeExecutorMcp,
    previewOpenApi: previewExecutorOpenApi
  }
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
      detection: { ...detection, kind: "mcp" },
      probe: await dependencies.catalog.probeMcp(detection.endpoint)
    }
  }
  if (detection.kind === "openapi") {
    return {
      url: normalizedUrl,
      detection: { ...detection, kind: "openapi" },
      preview: await dependencies.catalog.previewOpenApi(detection.endpoint)
    }
  }
  throw new Error(`Executor detected unsupported integration kind: ${detection.kind}`)
}

export const createIntegrationDiscovery = (
  dependencies: IntegrationDiscoveryDependencies
) => ({
  inspect: (url: string) => inspectWith(url, dependencies)
})

const defaultDiscovery = createIntegrationDiscovery(defaultDependencies)

/** Detects and probes an endpoint without changing persisted Executor state. */
export const inspectIntegration = defaultDiscovery.inspect
