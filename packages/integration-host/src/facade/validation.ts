import { Effect, Schema } from "effect"
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

interface IntegrationValidationEffects {
  readonly listTools: () => Effect.Effect<
    Awaited<ReturnType<ToolsApi["list"]>>,
    IntegrationValidationToolsError
  >
  readonly summarizeTools: (
    integration: string
  ) => Effect.Effect<
    Awaited<ReturnType<ToolsApi["summaries"]>>,
    IntegrationValidationToolsError
  >
}

class IntegrationValidationToolsError extends Schema.TaggedErrorClass<
  IntegrationValidationToolsError
>()("IntegrationValidationToolsError", {
  operation: Schema.String,
  cause: Schema.Defect
}) {}

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
const liveFindings = Effect.fn("integrationValidation.liveFindings")(function*(
  source: IntegrationNodeSource,
  tools: IntegrationValidationEffects
) {
  if (isAddressForm(source)) {
    const tool = (yield* tools.listTools()).find(
      (candidate) => candidate.address === source.address
    )
    return tool === undefined
      ? [finding("error", "catalog", `Tool not found: ${source.address}`)]
      : [finding("info", "catalog", `${tool.name} is available`)]
  }
  const matches = (yield* tools.summarizeTools(source.integration))
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
  dependencies: IntegrationValidationEffects,
  config: typeof Schema.Json.Type,
  options: { readonly live?: boolean } = {}
) {
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
    findings.push(...yield* liveFindings(node.source, dependencies))
  }
  return {
    ok: !findings.some((entry) => entry.severity === "error"),
    findings
  } satisfies IntegrationValidationReport
})

export const createIntegrationValidation = (
  dependencies: IntegrationValidationDependencies
) => (
  config: typeof Schema.Json.Type,
  options: { readonly live?: boolean } = {}
): Promise<IntegrationValidationReport> =>
    Effect.runPromise(validateIntegrationNode(
      {
        listTools: () => Effect.tryPromise({
          try: () => dependencies.tools.list(),
          catch: (cause) => new IntegrationValidationToolsError({
            operation: "list integration tools",
            cause
          })
        }),
        summarizeTools: (integration) => Effect.tryPromise({
          try: () => dependencies.tools.summaries({ integration }),
          catch: (cause) => new IntegrationValidationToolsError({
            operation: `summarize tools for ${integration}`,
            cause
          })
        })
      },
      config,
      options
    ))
