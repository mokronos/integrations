import { Schema } from "effect"
import {
  addExecutorMcp,
  addExecutorOpenApi,
  createExecutorConnection,
  detectExecutorIntegration,
  ExecutorAuthMethod,
  ExecutorDetection,
  ExecutorIntegration,
  ExecutorMcpProbe,
  ExecutorOpenApiPreview,
  ExecutorTool,
  ExecutorToolAddress,
  listExecutorConnections,
  listExecutorIntegrations,
  listExecutorTools,
  previewExecutorOpenApi,
  probeExecutorMcp
} from "../executor.ts"

export const IntegrationKind = Schema.Literals(["mcp", "openapi"])
export type IntegrationKind = typeof IntegrationKind.Type

export const IntegrationDiscovery = Schema.Struct({
  url: Schema.String,
  detection: ExecutorDetection,
  probe: Schema.optional(ExecutorMcpProbe),
  preview: Schema.optional(ExecutorOpenApiPreview),
  integration: ExecutorIntegration,
  requiresAuthentication: Schema.Boolean,
  authMethods: Schema.Array(ExecutorAuthMethod),
  tools: Schema.Array(ExecutorTool)
})
export type IntegrationDiscovery = typeof IntegrationDiscovery.Type

export interface DiscoverIntegrationsOptions {
  readonly connection?: string
}

export const IntegrationNodeConfig = Schema.Struct({
  source: Schema.Struct({
    kind: Schema.Literal("executor"),
    address: ExecutorToolAddress
  })
})
export type IntegrationNodeConfig = typeof IntegrationNodeConfig.Type

export const IntegrationValidationFinding = Schema.Struct({
  severity: Schema.Literals(["error", "warning", "info"]),
  check: Schema.String,
  message: Schema.String
})
export type IntegrationValidationFinding = typeof IntegrationValidationFinding.Type

export const IntegrationValidationReport = Schema.Struct({
  ok: Schema.Boolean,
  findings: Schema.Array(IntegrationValidationFinding)
})
export type IntegrationValidationReport = typeof IntegrationValidationReport.Type

const confidenceRank = (confidence: ExecutorDetection["confidence"]): number => {
  switch (confidence) {
    case "high": return 3
    case "medium": return 2
    case "low": return 1
  }
}

const bestDetection = (detections: ReadonlyArray<ExecutorDetection>): ExecutorDetection | undefined =>
  [...detections].sort((left, right) => confidenceRank(right.confidence) - confidenceRank(left.confidence))[0]

const existingIntegration = async (slug: string): Promise<ExecutorIntegration | undefined> =>
  (await listExecutorIntegrations()).find((integration) => integration.slug === slug)

const ensureConnection = async (
  integration: ExecutorIntegration,
  connectionName: string
): Promise<void> => {
  const existing = (await listExecutorConnections()).some((connection) =>
    connection.integration === integration.slug && connection.name === connectionName
  )
  if (existing) return
  const noAuth = integration.authMethods.find((method) => method.kind === "none")
  if (noAuth === undefined && integration.authMethods.length > 0) return
  await createExecutorConnection({
    integration: integration.slug,
    name: connectionName,
    template: noAuth?.template ?? "none",
    value: ""
  })
}

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

export const discoverIntegration = async (
  url: string,
  options: DiscoverIntegrationsOptions = {}
): Promise<IntegrationDiscovery> => {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported integration URL protocol: ${parsed.protocol}`)
  }
  const connectionName = options.connection ?? "default"
  const detection = await detectWithFallback(parsed.toString())
  if (detection.kind === "mcp") {
    const probe = await probeExecutorMcp(detection.endpoint)
    let registered = await existingIntegration(detection.slug)
    if (registered === undefined) {
      await addExecutorMcp({
        endpoint: detection.endpoint,
        name: probe.name,
        slug: detection.slug,
        auth: probe.requiresOAuth ? "oauth2" : probe.requiresAuthentication ? "bearer" : "none"
      })
      registered = await existingIntegration(detection.slug)
    }
    if (registered === undefined) throw new Error(`Executor did not persist MCP integration ${detection.slug}`)
    await ensureConnection(registered, connectionName)
    return {
      url: parsed.toString(),
      detection,
      probe,
      integration: registered,
      requiresAuthentication:
        registered.authMethods.length > 0 &&
        !registered.authMethods.some((method) => method.kind === "none"),
      authMethods: registered.authMethods,
      tools: await listExecutorTools({ integration: registered.slug, connection: connectionName })
    }
  }
  if (detection.kind !== "openapi") {
    throw new Error(`Executor detected unsupported integration kind: ${detection.kind}`)
  }
  const preview = await previewExecutorOpenApi(detection.endpoint)
  let registered = await existingIntegration(detection.slug)
  if (registered === undefined) {
    await addExecutorOpenApi({
      spec: detection.endpoint,
      slug: detection.slug,
      name: detection.name,
      ...(preview.servers[0]?.url === undefined ? {} : { baseUrl: preview.servers[0].url })
    })
    registered = await existingIntegration(detection.slug)
  }
  if (registered === undefined) throw new Error(`Executor did not persist OpenAPI integration ${detection.slug}`)
  await ensureConnection(registered, connectionName)
  return {
    url: parsed.toString(),
    detection,
    preview,
    integration: registered,
    requiresAuthentication:
      registered.authMethods.length > 0 &&
      !registered.authMethods.some((method) => method.kind === "none"),
    authMethods: registered.authMethods,
    tools: await listExecutorTools({ integration: registered.slug, connection: connectionName })
  }
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
