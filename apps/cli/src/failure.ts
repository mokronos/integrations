import { Data, Schema } from "effect"
import { GatewayError, isGatewayError, presentError } from "@integragents/contracts"
import type { ErrorCategory } from "@integragents/contracts"
import { IntegrationsCliError } from "./connection.ts"

/** A failure whose details are already on stdout, such as a denied call's outcome; only its exit code is left to set. */
export class ReportedFailure extends Data.TaggedError("ReportedFailure")<{ readonly exitCode: number }> {}

/** What the exit code tells a script to do next. */
export const exitCodes = {
  internal: 1,
  input: 2,
  auth: 3,
  unavailable: 4,
  upstream: 5
} satisfies Record<ErrorCategory, number>

export const exitCodeHelp =
  "Exit codes: 1 the gateway failed, 2 change the command or its input, 3 change the credential, " +
  "4 retry later, 5 the integration's service refused or failed."

const encodeError = Schema.encodeSync(GatewayError)

const humanReport = (error: GatewayError): string => {
  const presentation = presentError(error)
  const issues =
    presentation.issues.length < 2 ? [] : presentation.issues.map((issue) => `    ${issue.path}: ${issue.message}`)
  return [
    `error: ${presentation.message}`,
    ...issues,
    ...(presentation.hint === undefined || issues.length > 0 ? [] : [`  next: ${presentation.hint}`]),
    `  code: ${presentation.code} (HTTP ${presentation.status})${presentation.retryable ? ", retryable" : ""}`
  ].join("\n")
}

/**
 * Tells a failed command's error on stderr, so stdout only ever carries
 * results: a block for a person at a terminal, one JSON line for a program.
 * Answers the exit code.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const reportFailure = (failure: unknown): number => {
  if (failure instanceof ReportedFailure) return failure.exitCode
  const interactive = process.stderr.isTTY === true
  if (isGatewayError(failure)) {
    console.error(interactive ? humanReport(failure) : JSON.stringify({ error: encodeError(failure) }))
    return exitCodes[presentError(failure).category]
  }
  const message = failure instanceof Error ? failure.message : String(failure)
  console.error(interactive ? `error: ${message}` : JSON.stringify({ error: { message } }))
  return failure instanceof IntegrationsCliError ? exitCodes.input : exitCodes.internal
}
