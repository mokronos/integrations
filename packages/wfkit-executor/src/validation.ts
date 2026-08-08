import { Schema } from "effect"
import {
  IntegrationNodeConfig,
  type IntegrationValidationFinding,
  type IntegrationValidationReport
} from "./integration-model.ts"
import { listExecutorTools } from "./tools.ts"
import type { ExecutorTools } from "./tools.ts"

export interface IntegrationValidationDependencies {
  readonly tools: Pick<ExecutorTools, "list">
}

const finding = (
  severity: IntegrationValidationFinding["severity"],
  check: string,
  message: string
): IntegrationValidationFinding => ({ severity, check, message })

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
    finding("info", "structural", "Executor tool address is valid")
  ]
  if (options.live === true) {
    const tool = (await dependencies.tools.list()).find((candidate) =>
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

export const validateIntegrationNode = createIntegrationValidation({
  tools: { list: listExecutorTools }
})
