import type { GatewayClient } from "@mokronos/integrations-client"
import type { HttpClient } from "effect/unstable/http"
import { Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { Alias } from "@integrations/contracts"
import { InvocationOutcome } from "@integrations/contracts"
import type { IntegrationsCliError } from "../connection.ts"
import { cliError, connectToGateway, describeError } from "../connection.ts"
import {
  jsonOutput,
  writeStdoutLine
} from "../output.ts"

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

const readJsonArgument = Effect.fn("cli.readJsonArgument")(function*(
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

export const operatorExecuteCommand = Command.make(
  "execute",
  {
    target: Argument.string("alias").pipe(
      Argument.withDescription("Effective tool alias")
    ),
    second: Argument.string("tool").pipe(
      Argument.withDescription("Effective tool name")
    ),
    third: Argument.string("json").pipe(
      Argument.optional,
      Argument.withDescription("Arguments as JSON (default: {})")
    ),
    file: Flag.string("file").pipe(
      Flag.optional,
      Flag.withDescription("Read the JSON input from a file")
    ),
    verbose: verboseFlag()
  },
  ({ target, second, third, file, verbose }) => {
    const invocation = gatewayTask((client) =>
      Effect.gen(function*() {
        const payload = yield* readJsonArgument(
          Option.getOrUndefined(third),
          Option.getOrUndefined(file)
        )
        return yield* client.delegated.execute({
          payload: {
            alias: Alias.make(target),
            tool: second,
            arguments: payload
          }
        })
      }))
    return invocation.pipe(Effect.flatMap((outcome) =>
      writeStdoutLine(
        jsonOutput(encodeOutcome(outcome), verbose)
      ).pipe(Effect.flatMap(() =>
        outcome.status === "succeeded" || outcome.status === "pending"
          ? Effect.void
          : Effect.fail(cliError(
            outcome.status === "denied" ? outcome.reason : outcome.message
          ))
      ))
    ))
  }
).pipe(
  Command.withDescription(
    "Invoke an effective policy tool through its alias"
  )
)

export const clientExecuteCommand = Command.make(
  "execute",
  {
    alias: Argument.string("alias").pipe(
      Argument.withDescription("Effective tool alias")
    ),
    tool: Argument.string("tool").pipe(
      Argument.withDescription("Effective tool name")
    ),
    json: Argument.string("json").pipe(
      Argument.optional,
      Argument.withDescription("Arguments as JSON (default: {})")
    ),
    file: Flag.string("file").pipe(
      Flag.optional,
      Flag.withDescription("Read the JSON input from a file")
    ),
    verbose: verboseFlag()
  },
  ({ alias, tool, json, file, verbose }) =>
    gatewayTask((client) =>
      readJsonArgument(
        Option.getOrUndefined(json),
        Option.getOrUndefined(file)
      ).pipe(Effect.flatMap((arguments_) =>
        client.delegated.execute({
          payload: { alias: Alias.make(alias), tool, arguments: arguments_ }
        })
      ))
    ).pipe(Effect.flatMap((outcome) =>
      writeStdoutLine(
        jsonOutput(encodeOutcome(outcome), verbose)
      ).pipe(Effect.flatMap(() =>
        outcome.status === "succeeded" || outcome.status === "pending"
          ? Effect.void
          : Effect.fail(cliError(
            outcome.status === "denied" ? outcome.reason : outcome.message
          ))
      ))
    ))
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
