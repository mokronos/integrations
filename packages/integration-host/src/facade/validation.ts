import { Schema } from "effect"
import type { ToolsApi } from "./api.ts"
import {
  IntegrationNodeConfig,
  type IntegrationNodeSource,
  type IntegrationValidationFinding,
  type IntegrationValidationReport
} from "@mokronos/contracts"

export interface IntegrationValidationDependencies {
  readonly tools: Pick<ToolsApi, "list" | "summaries">
}

const finding = (
  severity: IntegrationValidationFinding["severity"],
  check: string,
  message: string
): IntegrationValidationFinding => ({ severity, check, message })

const isAddressForm = (
  source: IntegrationNodeSource
): source is Extract<IntegrationNodeSource, { readonly address: string }> => "address" in source

/** The live half: does this node point at something callable right now?
 *
 *  This checks the catalog only. Whether a *caller* may reach it is a different
 *  question, answered by the gateway against that caller's grants. */
const liveFindings = async (
  source: IntegrationNodeSource,
  tools: Pick<ToolsApi, "list" | "summaries">
): Promise<ReadonlyArray<IntegrationValidationFinding>> => {
  if (isAddressForm(source)) {
    const tool = (await tools.list()).find((candidate) => candidate.address === source.address)
    return tool === undefined
      ? [finding("error", "catalog", `Tool not found: ${source.address}`)]
      : [finding("info", "catalog", `${tool.name} is available`)]
  }
  const matches = (await tools.summaries({ integration: source.integration }))
    .filter((candidate) => candidate.name === source.tool)
  if (matches.length === 0) {
    return [finding(
      "error",
      "catalog",
      `${source.integration}.${source.tool} is not available on this machine`
    )]
  }
  return [finding(
    "info",
    "catalog",
    `${source.tool} is available on ${matches.map((match) => match.connection).join(", ")}`
  )]
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
        ? "Tool address is valid"
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
