import { Effect, Schema } from "effect"
import { IntegrationHost } from "./host.ts"
import type { StorageError } from "./errors.ts"
import {
  IntegrationNodeConfig,
  IntegrationSlug,
  type IntegrationNodeSource,
  type IntegrationValidationFinding,
  type IntegrationValidationReport
} from "@mokronos/contracts"

/** Whether a workflow's integration node points at something callable.

 *  The catalog reads were Promise calls wrapped in a bespoke
 *  `IntegrationValidationToolsError`, which existed only to give the rejection a
 *  tag. The host's own `StorageError` already says what went wrong. */

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
 *  question, answered by the gateway against that caller's policy and bindings. */
const liveFindings = Effect.fn("integrationValidation.liveFindings")(function*(
  source: IntegrationNodeSource,
  host: IntegrationHost["Service"]
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
): Effect.fn.Return<IntegrationValidationReport, StorageError, IntegrationHost> {
  const host = yield* IntegrationHost
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

