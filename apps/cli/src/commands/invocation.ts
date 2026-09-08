import type { GatewayClient } from "@mokronos/integrations-client"
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

const gatewayTask = <A>(
  task: (client: GatewayClient) => Promise<A>
): Effect.Effect<A, IntegrationsCliError> =>
  Effect.tryPromise({
    try: async () => await task(await connectToGateway()),
    catch: (error) => cliError(describeError(error))
  })

type GatewayTask = typeof gatewayTask

const controlPlaneTask = <A>(
  task: (client: ControlPlaneClient) => Promise<A>
): Effect.Effect<A, IntegrationsCliError> =>
  Effect.tryPromise({
    try: async () => await task(await connectToControlPlane()),
    catch: (error) => cliError(describeError(error))
  })

const JsonObject = Schema.Record(Schema.String, Schema.Json)
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

const record = <A>(value: A | undefined): Record<string, typeof Schema.Json.Type> =>
  Option.getOrElse(Schema.decodeUnknownOption(JsonObject)(value), () => ({}))

const readJsonArgument = async (
  inline_: string | undefined,
  file: string | undefined
): Promise<typeof Schema.Json.Type> => {
  if (inline_ !== undefined && file !== undefined) {
    throw cliError("Provide JSON input or --file, not both")
  }
  const source = file === undefined ? inline_ ?? "{}" : await Bun.file(file).text()
  try {
    return decodeJsonText(source)
  } catch (error) {
    throw cliError(
      `Input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

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
      ? controlPlaneTask(async (client) => {
        if (!looksLikeAddress(target)) {
          throw cliError(
            `--direct expects a tools.<integration>.<owner>.<connection>.<tool> address, got "${target}". Copy one from: i schema <integration> <tool>`
          )
        }
        if (Option.isSome(third)) {
          throw cliError("In direct mode the address is followed by the JSON input only")
        }
        const payload = await readJsonArgument(
          Option.getOrUndefined(second),
          Option.getOrUndefined(file)
        )
        try {
          return {
            status: "succeeded",
            result: await client.request("POST", "/v1/tools/invoke", {
              address: target,
              arguments: payload
            })
          } as const
        } catch (error) {
          return { status: "failed", message: describeError(error) } as const
        }
      })
      : gatewayTask(async (client) => {
        if (Option.isNone(second)) {
          throw cliError("Provide an alias and a tool, or a tools.… address with --direct")
        }
        const payload = await readJsonArgument(
          Option.getOrUndefined(third),
          Option.getOrUndefined(file)
        )
        return await client.execute({
          alias: target,
          tool: second.value,
          arguments: Schema.decodeUnknownSync(Schema.Json)(payload)
        })
      })
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
    gatewayTask(async (client) =>
      await client.execute({
        alias,
        tool,
        arguments: await readJsonArgument(
          Option.getOrUndefined(json),
          Option.getOrUndefined(file)
        )
      })
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
    runGateway(async (client) => {
      const configText = Option.getOrUndefined(config)
      const filePath = Option.getOrUndefined(file)
      if ((configText === undefined) === (filePath === undefined)) {
        throw cliError("Provide exactly one of a JSON config or --file")
      }
      const source = filePath === undefined
        ? looksLikeAddress(configText ?? "")
          ? JSON.stringify({ source: { kind: "tool", address: configText } })
          : configText ?? "{}"
        : await Bun.file(filePath).text()
      return record(await client.validate({
        node: decodeJsonText(source),
        live: !structural
      }))
    }).pipe(Effect.flatMap((report) =>
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
