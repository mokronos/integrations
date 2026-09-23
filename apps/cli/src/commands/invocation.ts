import type { GatewayClient } from "@integragents/client"
import type { HttpClient } from "effect/unstable/http"
import { Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { Alias, InvocationOutcome, SubjectId, whenPresentMap } from "@integragents/contracts"
import type { IntegrationsCliError } from "../connection.ts"
import { cliError, connectToGateway, describeError } from "../connection.ts"
import {
  jsonOutput,
  writeStdoutLine
} from "../output.ts"
import { materializeBlobs, resolveFileArguments } from "../blobs.ts"

const outFlag = () =>
  Flag.string("out").pipe(
    Flag.optional,
    Flag.withDescription("Write file results to this path instead of the download directory")
  )

const verboseFlag = () =>
  Flag.boolean("verbose").pipe(
    Flag.withDefault(false),
    Flag.withAlias("v"),
    Flag.withDescription("Show complete objects, pretty-printed")
  )

const gatewayTask = <A, E, R>(
  task: (client: GatewayClient) => Effect.Effect<A, E, R>
): Effect.Effect<A, IntegrationsCliError, R | HttpClient.HttpClient> =>
  connectToGateway().pipe(
    Effect.flatMap(task),
    Effect.mapError((error) => cliError(describeError(error)))
  )

type GatewayTask = typeof gatewayTask

const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

/** Printed as it travelled: the decoded outcome carries a Date, JSON does not. */
const encodeOutcome = Schema.encodeSync(InvocationOutcome)

const readJsonArgument = Effect.fn("Cli.readJsonArgument")(function*(
  inline_: string | undefined,
  file: string | undefined
): Effect.fn.Return<typeof Schema.Json.Type, IntegrationsCliError> {
  if (inline_ !== undefined && file !== undefined) {
    return yield* cliError("Provide JSON input or --file, not both")
  }
  const source = file === undefined
    ? inline_ ?? "{}"
    : yield* Effect.tryPromise({
      try: () => Bun.file(file).text(),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters
      catch: (cause: unknown) => cliError(describeError(cause))
    })
  return yield* Effect.try({
    try: () => decodeJsonText(source),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    catch: (cause: unknown) =>
      cliError(
        `Input is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`
      )
  })
})

const looksLikeAddress = (value: string): boolean => value.startsWith("tools.")

/** File results are fetched onto local disk before the agent ever sees them. */
const settleOutcome = (
  client: GatewayClient,
  outcome: InvocationOutcome,
  out: string | undefined
): Effect.Effect<InvocationOutcome, IntegrationsCliError> =>
  outcome.status === "succeeded"
    ? Effect.map(
      materializeBlobs(client, outcome.result, out),
      (result): InvocationOutcome => ({ ...outcome, result })
    )
    : Effect.succeed(outcome)

const subjectFlag = () =>
  Flag.string("subject").pipe(
    Flag.optional,
    Flag.withDescription("The user this call acts for; delegated tools require it")
  )

const reportOutcome = (
  outcome: InvocationOutcome,
  verbose: boolean
): Effect.Effect<void, IntegrationsCliError> =>
  writeStdoutLine(jsonOutput(encodeOutcome(outcome), verbose)).pipe(
    Effect.flatMap(() =>
      outcome.status === "succeeded" || outcome.status === "pending" || outcome.status === "authorization-required"
        ? Effect.void
        : Effect.fail(cliError(
          outcome.status === "denied"
            ? outcome.reason
            : outcome.status === "invalid"
            ? [outcome.message, ...outcome.issues.map((issue) => `  ${issue.path}: ${issue.message}`)].join("\n")
            : outcome.message
        ))
    )
  )

export const operatorExecuteCommand = Command.make(
  "execute",
  {
    target: Argument.string("alias").pipe(
      Argument.withDescription("Tool alias")
    ),
    second: Argument.string("tool").pipe(
      Argument.withDescription("Tool name")
    ),
    third: Argument.string("json").pipe(
      Argument.optional,
      Argument.withDescription("Arguments as JSON (default: {})")
    ),
    file: Flag.string("file").pipe(
      Flag.optional,
      Flag.withDescription("Read the JSON input from a file")
    ),
    subject: subjectFlag(),
    out: outFlag(),
    verbose: verboseFlag()
  },
  ({ target, second, third, file, subject, out, verbose }) =>
    gatewayTask((client) =>
      Effect.gen(function*() {
        const payload = yield* resolveFileArguments(
          client,
          yield* readJsonArgument(
            Option.getOrUndefined(third),
            Option.getOrUndefined(file)
          )
        )
        const outcome = yield* client.delegated.execute({
          payload: {
            alias: Alias.make(target),
            tool: second,
            arguments: payload,
            ...whenPresentMap("subject", Option.getOrUndefined(subject), SubjectId.make)
          }
        })
        return yield* settleOutcome(client, outcome, Option.getOrUndefined(out))
      })).pipe(Effect.flatMap((outcome) => reportOutcome(outcome, verbose)))
).pipe(
  Command.withDescription(
    "Invoke an effective policy tool through its alias"
  )
)

export const clientExecuteCommand = Command.make(
  "execute",
  {
    alias: Argument.string("alias").pipe(
      Argument.withDescription("Tool alias")
    ),
    tool: Argument.string("tool").pipe(
      Argument.withDescription("Tool name")
    ),
    json: Argument.string("json").pipe(
      Argument.optional,
      Argument.withDescription("Arguments as JSON (default: {})")
    ),
    file: Flag.string("file").pipe(
      Flag.optional,
      Flag.withDescription("Read the JSON input from a file")
    ),
    subject: subjectFlag(),
    out: outFlag(),
    verbose: verboseFlag()
  },
  ({ alias, tool, json, file, subject, out, verbose }) =>
    gatewayTask((client) =>
      Effect.gen(function*() {
        const arguments_ = yield* resolveFileArguments(
          client,
          yield* readJsonArgument(
            Option.getOrUndefined(json),
            Option.getOrUndefined(file)
          )
        )
        const outcome = yield* client.delegated.execute({
          payload: {
            alias: Alias.make(alias),
            tool,
            arguments: arguments_,
            ...whenPresentMap("subject", Option.getOrUndefined(subject), SubjectId.make)
          }
        })
        return yield* settleOutcome(client, outcome, Option.getOrUndefined(out))
      })
    ).pipe(Effect.flatMap((outcome) => reportOutcome(outcome, verbose)))
).pipe(Command.withDescription("Invoke a connected tool through its alias"))

export const validateCommand = (runGateway: GatewayTask) => Command.make(
  "validate",
  {
    config: Argument.string("json-or-tool-address").pipe(Argument.optional),
    file: Flag.string("file").pipe(Flag.optional),
    structural: Flag.boolean("structural").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Check the shape only, without checking what resolves")
    ),
    verbose: verboseFlag()
  },
  ({ config, file, structural, verbose }) =>
    runGateway((client) =>
      Effect.gen(function*() {
        const configText = Option.getOrUndefined(config)
        const filePath = Option.getOrUndefined(file)
        if ((configText === undefined) === (filePath === undefined)) {
          return yield* cliError("Provide exactly one of a JSON config or --file")
        }
        const source = filePath === undefined
          ? looksLikeAddress(configText ?? "")
            ? JSON.stringify({ source: { kind: "tool", address: configText } })
            : configText ?? "{}"
          : yield* Effect.tryPromise({
            try: () => Bun.file(filePath).text(),
            // oxlint-disable-next-line anti-slop/no-unknown-parameters
            catch: (cause: unknown) => cliError(describeError(cause))
          })
        return yield* client.provisioning.validate({ payload: {
          node: decodeJsonText(source),
          live: !structural
        } })
      })).pipe(Effect.flatMap((report) =>
      writeStdoutLine(jsonOutput(report, verbose)).pipe(
        Effect.flatMap(() =>
          report["ok"] === true
            ? Effect.void
            : Effect.fail(cliError("Integration validation failed"))
        )
      )
    ))
).pipe(
  Command.withDescription(
    "Validate an integration alias, tool address, or node config"
  )
)
