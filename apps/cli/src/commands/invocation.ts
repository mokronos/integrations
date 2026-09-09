import type { GatewayClient } from "@mokronos/integrations-client"
import type { HttpClient } from "effect/unstable/http"
import { Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import type { IntegrationsCliError } from "../connection.ts"
import { cliError, connectToGateway, describeError } from "../connection.ts"
import {
  jsonOutput,
  writeStdoutLine
} from "../output.ts"
import type { ControlPlaneClient } from "../session.ts"
import { connectToControlPlane } from "../session.ts"

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

const controlPlaneTask = <A, E>(
  task: (client: ControlPlaneClient) => Effect.Effect<A, E, HttpClient.HttpClient>
): Effect.Effect<A, IntegrationsCliError, HttpClient.HttpClient> =>
  connectToControlPlane().pipe(
    Effect.flatMap(task),
    Effect.mapError((error) => cliError(describeError(error)))
  )

const JsonObject = Schema.Record(Schema.String, Schema.Json)
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

const record = <A>(value: A | undefined): Record<string, typeof Schema.Json.Type> =>
  Option.getOrElse(Schema.decodeUnknownOption(JsonObject)(value), () => ({}))

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
    target: Argument.string("alias-or-address").pipe(
      Argument.withDescription("Effective tool alias, or a tools.… address with --direct")
    ),
    second: Argument.string("tool").pipe(
      Argument.optional,
      Argument.withDescription("Tool name. Omitted in direct mode, where the address names it")
    ),
    third: Argument.string("json").pipe(
      Argument.optional,
      Argument.withDescription("Arguments as JSON (default: {})")
    ),
    direct: Flag.boolean("direct").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Call a tool address with this key's own authority, bypassing aliases. For testing a connection"
      )
    ),
    file: Flag.string("file").pipe(
      Flag.optional,
      Flag.withDescription("Read the JSON input from a file")
    ),
    verbose: verboseFlag()
  },
  ({ target, second, third, direct, file, verbose }) => {
    const isDirect = direct || looksLikeAddress(target)
    const invocation = isDirect
      ? controlPlaneTask((client) =>
        Effect.gen(function*() {
          if (!looksLikeAddress(target)) {
            return yield* cliError(
              `--direct expects a tools.<integration>.<owner>.<connection>.<tool> address, got "${target}". Copy one from: i schema <integration> <tool>`
            )
          }
          if (Option.isSome(third)) {
            return yield* cliError(
              "In direct mode the address is followed by the JSON input only"
            )
          }
          const payload = yield* readJsonArgument(
            Option.getOrUndefined(second),
            Option.getOrUndefined(file)
          )
          return yield* client.request("POST", "/v1/tools/invoke", {
            address: target,
            arguments: payload
          }).pipe(
            Effect.match({
              onSuccess: (result) => ({ status: "succeeded", result } as const),
              onFailure: (error) => ({ status: "failed", message: describeError(error) } as const)
            })
          )
        }))
      : gatewayTask((client) =>
        Effect.gen(function*() {
          if (Option.isNone(second)) {
            return yield* cliError(
              "Provide an alias and a tool, or a tools.… address with --direct"
            )
          }
          const payload = yield* readJsonArgument(
            Option.getOrUndefined(third),
            Option.getOrUndefined(file)
          )
          return yield* client.execute({
            alias: target,
            tool: second.value,
            arguments: payload
          })
        }))
    return invocation.pipe(Effect.flatMap((outcome) =>
      writeStdoutLine(
        jsonOutput(Schema.decodeUnknownSync(Schema.Json)(outcome), verbose)
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
    "Invoke an effective policy tool through an alias. --direct calls an address instead"
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
        client.execute({ alias, tool, arguments: arguments_ })
      ))
    ).pipe(Effect.flatMap((outcome) =>
      writeStdoutLine(
        jsonOutput(Schema.decodeUnknownSync(Schema.Json)(outcome), verbose)
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
        return record(yield* client.validate({
          node: decodeJsonText(source),
          live: !structural
        }))
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
