import type { Attachment, GatewayError } from "@integragents/contracts"
import { exitCodes, ReportedFailure } from "../failure.ts"
import type { GatewayClient } from "@integragents/client"
import { Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { Alias, IdempotencyKey, InvocationOutcome, whenPresent, whenTrue } from "@integragents/contracts"
import type { IntegrationsCliError } from "../connection.ts"
import { cliError, thrownMessage } from "../connection.ts"
import { jsonOutput, writeStdoutLine } from "../output.ts"
import { materializeBlobs, materializeHandle, resolveFileArguments } from "../blobs.ts"
import { gatewayTask } from "../tasks.ts"
import type { GatewayTask } from "../tasks.ts"

const outFlag = () =>
  Flag.String("out").pipe(
    Flag.optional,
    Flag.withDescription("Write file results to this path instead of the download directory")
  )

const verboseFlag = () =>
  Flag.Boolean("verbose").pipe(
    Flag.withDefault(false),
    Flag.withAlias("v"),
    Flag.withDescription("Show complete objects, pretty-printed")
  )

const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

/** Printed as it travelled: the decoded outcome carries a Date, JSON does not. */
const encodeOutcome = Schema.encodeSync(InvocationOutcome)

const readJsonArgument = Effect.fn("Cli.readJsonArgument")(function* (
  inline_: string | undefined,
  file: string | undefined
): Effect.fn.Return<typeof Schema.Json.Type, IntegrationsCliError> {
  if (inline_ !== undefined && file !== undefined) {
    return yield* cliError("Provide JSON input or --file, not both")
  }
  const source =
    file === undefined
      ? (inline_ ?? "{}")
      : yield* Effect.tryPromise({
          try: () => Bun.file(file).text(),
          // oxlint-disable-next-line anti-slop/no-unknown-parameters
          catch: (cause: unknown) => cliError(thrownMessage(cause))
        })
  return yield* Effect.try({
    try: () => decodeJsonText(source),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    catch: (cause: unknown) =>
      cliError(`Input is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  })
})

const looksLikeAddress = (value: string): boolean => value.startsWith("tools.")

/** File results and attached media are fetched onto local disk before the agent ever sees them. */
const settleOutcome = (
  client: GatewayClient,
  outcome: InvocationOutcome,
  out: string | undefined
): Effect.Effect<InvocationOutcome, IntegrationsCliError> =>
  outcome.status === "succeeded"
    ? Effect.gen(function* () {
        const result = yield* materializeBlobs(client, outcome.result, out)
        const attachments = yield* Effect.forEach(
          outcome.attachments ?? [],
          (attachment): Effect.Effect<Attachment, IntegrationsCliError> =>
            "blob" in attachment
              ? Effect.map(materializeHandle(client, attachment.blob, undefined), (blob) => ({ ...attachment, blob }))
              : Effect.succeed(attachment)
        )
        return { ...outcome, result, ...whenTrue(attachments.length > 0, () => ({ attachments })) }
      })
    : Effect.succeed(outcome)

const idempotencyKeyFlag = () =>
  Flag.String("idempotency-key").pipe(
    Flag.withSchema(IdempotencyKey),
    Flag.optional,
    Flag.withDescription(
      "Your name for this call, the same on every retry: a retry gets the first call's outcome instead of running again"
    )
  )

/** A call that ran into a failure fails the command with it; one a human denied is reported, then exits 2. */
const reportOutcome = (
  outcome: InvocationOutcome,
  verbose: boolean
): Effect.Effect<void, GatewayError | ReportedFailure> => {
  switch (outcome.status) {
    case "invalid":
      return Effect.fail(outcome.error)
    case "failed":
      if (outcome.error !== undefined) return Effect.fail(outcome.error)
      return writeStdoutLine(jsonOutput(encodeOutcome(outcome), verbose)).pipe(
        Effect.andThen(Effect.fail(new ReportedFailure({ exitCode: exitCodes.internal })))
      )
    case "denied":
      return writeStdoutLine(jsonOutput(encodeOutcome(outcome), verbose)).pipe(
        Effect.andThen(Effect.fail(new ReportedFailure({ exitCode: exitCodes.input })))
      )
    case "succeeded":
    case "pending":
    case "authorization-required":
    case "input-required":
      return writeStdoutLine(jsonOutput(encodeOutcome(outcome), verbose))
  }
}

export const operatorExecuteCommand = Command.make(
  "execute",
  {
    target: Argument.String("alias").pipe(Argument.withDescription("Tool alias")),
    second: Argument.String("tool").pipe(Argument.withDescription("Tool name")),
    third: Argument.String("json").pipe(Argument.optional, Argument.withDescription("Arguments as JSON (default: {})")),
    file: Flag.String("file").pipe(Flag.optional, Flag.withDescription("Read the JSON input from a file")),
    idempotencyKey: idempotencyKeyFlag(),
    out: outFlag(),
    verbose: verboseFlag()
  },
  ({ target, second, third, file, idempotencyKey, out, verbose }) =>
    gatewayTask((client) =>
      Effect.gen(function* () {
        const payload = yield* resolveFileArguments(
          client,
          yield* readJsonArgument(Option.getOrUndefined(third), Option.getOrUndefined(file))
        )
        const outcome = yield* client.delegated.execute({
          payload: {
            alias: Alias.make(target),
            tool: second,
            arguments: payload,
            ...whenPresent("idempotencyKey", Option.getOrUndefined(idempotencyKey))
          }
        })
        return yield* settleOutcome(client, outcome, Option.getOrUndefined(out))
      })
    ).pipe(Effect.flatMap((outcome) => reportOutcome(outcome, verbose)))
).pipe(Command.withDescription("Invoke one of the profile's tools through its alias"))

export const clientExecuteCommand = Command.make(
  "execute",
  {
    alias: Argument.String("alias").pipe(Argument.withDescription("Tool alias")),
    tool: Argument.String("tool").pipe(Argument.withDescription("Tool name")),
    json: Argument.String("json").pipe(Argument.optional, Argument.withDescription("Arguments as JSON (default: {})")),
    file: Flag.String("file").pipe(Flag.optional, Flag.withDescription("Read the JSON input from a file")),
    idempotencyKey: idempotencyKeyFlag(),
    out: outFlag(),
    verbose: verboseFlag()
  },
  ({ alias, tool, json, file, idempotencyKey, out, verbose }) =>
    gatewayTask((client) =>
      Effect.gen(function* () {
        const arguments_ = yield* resolveFileArguments(
          client,
          yield* readJsonArgument(Option.getOrUndefined(json), Option.getOrUndefined(file))
        )
        const outcome = yield* client.delegated.execute({
          payload: {
            alias: Alias.make(alias),
            tool,
            arguments: arguments_,
            ...whenPresent("idempotencyKey", Option.getOrUndefined(idempotencyKey))
          }
        })
        return yield* settleOutcome(client, outcome, Option.getOrUndefined(out))
      })
    ).pipe(Effect.flatMap((outcome) => reportOutcome(outcome, verbose)))
).pipe(Command.withDescription("Invoke a connected tool through its alias"))

export const validateCommand = (runGateway: GatewayTask) =>
  Command.make(
    "validate",
    {
      config: Argument.String("json-or-tool-address").pipe(Argument.optional),
      file: Flag.String("file").pipe(Flag.optional),
      structural: Flag.Boolean("structural").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Check the shape only, without checking what resolves")
      ),
      verbose: verboseFlag()
    },
    ({ config, file, structural, verbose }) =>
      runGateway((client) =>
        Effect.gen(function* () {
          const configText = Option.getOrUndefined(config)
          const filePath = Option.getOrUndefined(file)
          if ((configText === undefined) === (filePath === undefined)) {
            return yield* cliError("Provide exactly one of a JSON config or --file")
          }
          const source =
            filePath === undefined
              ? looksLikeAddress(configText ?? "")
                ? JSON.stringify({ source: { kind: "tool", address: configText } })
                : (configText ?? "{}")
              : yield* Effect.tryPromise({
                  try: () => Bun.file(filePath).text(),
                  // oxlint-disable-next-line anti-slop/no-unknown-parameters
                  catch: (cause: unknown) => cliError(thrownMessage(cause))
                })
          return yield* client.provisioning.validate({
            payload: {
              node: decodeJsonText(source),
              live: !structural
            }
          })
        })
      ).pipe(
        Effect.flatMap((report) =>
          writeStdoutLine(jsonOutput(report, verbose)).pipe(
            Effect.flatMap(() =>
              report["ok"] === true ? Effect.void : Effect.fail(cliError("Integration validation failed"))
            )
          )
        )
      )
  ).pipe(Command.withDescription("Validate an integration alias, tool address, or node config"))
