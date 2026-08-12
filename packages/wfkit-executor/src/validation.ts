import { Schema } from "effect"
import {
  IntegrationNodeConfig,
  type IntegrationNodeSource,
  type IntegrationValidationFinding,
  type IntegrationValidationReport
} from "./integration-model.ts"
import {
  describeIntegrationResolution,
  resolveIntegrationSource
} from "./integration-resolution.ts"
import { listExecutorTools, listExecutorToolSummaries } from "./tools.ts"
import type { ExecutorTools } from "./tools.ts"

export interface IntegrationValidationDependencies {
  readonly tools: Pick<ExecutorTools, "list" | "summaries">
}

const finding = (
  severity: IntegrationValidationFinding["severity"],
  check: string,
  message: string
): IntegrationValidationFinding => ({ severity, check, message })

const isAddressForm = (
  source: IntegrationNodeSource
): source is Extract<IntegrationNodeSource, { readonly address: string }> => "address" in source

/** The live half: does this node point at something callable right now? An
 *  address is looked up as-is; a portable reference goes through the same
 *  resolution the invoker uses, so validation and execution cannot disagree. */
const liveFindings = async (
  source: IntegrationNodeSource,
  tools: Pick<ExecutorTools, "list" | "summaries">
): Promise<ReadonlyArray<IntegrationValidationFinding>> => {
  if (isAddressForm(source)) {
    const tool = (await tools.list()).find((candidate) => candidate.address === source.address)
    return tool === undefined
      ? [finding("error", "catalog", `Executor tool not found: ${source.address}`)]
      : [finding("info", "catalog", `${tool.name} is available`)]
  }
  const resolution = await resolveIntegrationSource(source, tools)
  const message = describeIntegrationResolution(source, resolution)
  return resolution.status === "resolved"
    ? [finding("info", "catalog", message)]
    : [finding("error", "catalog", message)]
}

export const createIntegrationValidation = (
  dependencies: IntegrationValidationDependencies
) => async (
    config: typeof Schema.Json.Type,
    options: { readonly live?: boolean } = {}
  ): Promise<IntegrationValidationReport> => {
  let node: typeof IntegrationNodeConfig.Type
  try {
    node = await Schema.decodeUnknownPromise(IntegrationNodeConfig)(config)
  } catch (error) {
    return {
      ok: false,
      findings: [finding("error", "structural", `invalid integration node: ${String(error)}`)]
    }
  }
  const findings: Array<IntegrationValidationFinding> = [
    finding(
      "info",
      "structural",
      isAddressForm(node.source)
        ? "Executor tool address is valid"
        : "Integration reference is valid"
    )
  ]
  if (options.live === true) {
    findings.push(...await liveFindings(node.source, dependencies.tools))
  }
  return {
    ok: !findings.some((entry) => entry.severity === "error"),
    findings
  }
}

export const validateIntegrationNode = createIntegrationValidation({
  tools: { list: listExecutorTools, summaries: listExecutorToolSummaries }
})
