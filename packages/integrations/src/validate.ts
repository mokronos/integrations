import { Effect, Schema } from "effect"
import { Integrations } from "./integrations.ts"
import type { StorageError } from "./errors.ts"
import {
  IntegrationNodeConfig,
  IntegrationSlug,
  type IntegrationNodeSource,
  type IntegrationValidationFinding,
  type IntegrationValidationReport
} from "@integrations/contracts"

const finding = (
  severity: IntegrationValidationFinding["severity"],
  check: string,
  message: string
): IntegrationValidationFinding => ({ severity, check, message })

const isAddressForm = (
  source: IntegrationNodeSource
): source is Extract<IntegrationNodeSource, { readonly address: string }> => "address" in source

const liveFindings = Effect.fn("integrationValidation.liveFindings")(function*(
  source: IntegrationNodeSource,
  host: Integrations["Service"]
) {
  if (isAddressForm(source)) {
    const tool = (yield* host.listTools()).find(
      (candidate) => candidate.address === source.address
    )
    return tool === undefined
      ? [finding("error", "catalog", `Tool not found: ${source.address}`)]
      : [finding("info", "catalog", `${tool.name} is available`)]
  }
  const matches = (yield* host.toolSummaries({ integration: IntegrationSlug.make(source.integration) }))
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
})

export const validateIntegrationNode = Effect.fn("integrationValidation.validate")(function*(
  config: typeof Schema.Json.Type,
  options: { readonly live?: boolean } = {}
): Effect.fn.Return<IntegrationValidationReport, StorageError, Integrations> {
  const host = yield* Integrations
  const decoded = yield* Effect.result(Schema.decodeUnknownEffect(IntegrationNodeConfig)(config))
  if (decoded._tag === "Failure") {
    return {
      ok: false,
      findings: [finding(
        "error",
        "structural",
        `invalid integration node: ${String(decoded.failure)}`
      )]
    } satisfies IntegrationValidationReport
  }

  const node = decoded.success
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
    findings.push(...yield* liveFindings(node.source, host))
  }
  return {
    ok: !findings.some((entry) => entry.severity === "error"),
    findings
  } satisfies IntegrationValidationReport
})
