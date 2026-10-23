#!/usr/bin/env bun
import { BunHttpClient } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { cliLayer, commandSpan } from "./telemetry.ts"
import { clientSubcommands } from "./commands.ts"
import packageMetadata from "../package.json" with { type: "json" }
import { exitCodeHelp, exitCodes, reportFailure } from "./failure.ts"

export const rootCommand = Command.make("i").pipe(
  Command.withDescription(`Discover, connect, and invoke integrations. ${exitCodeHelp}`),
  Command.withSubcommands(clientSubcommands)
)

export const main = async (argv: ReadonlyArray<string>): Promise<void> => {
  await Effect.runPromise(
    Command.runWith(rootCommand, { version: packageMetadata.version })(argv).pipe(
      Effect.catchTag("ShowHelp", (error) =>
        error.errors.length === 0
          ? Effect.void
          : Effect.sync(() => {
              process.exitCode = exitCodes.input
            })
      ),
      commandSpan(argv),
      Effect.provide(Layer.merge(cliLayer("integrations-agent-cli"), BunHttpClient.layer))
    )
  )
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
    process.exitCode = process.exitCode ?? 0
  } catch (cause) {
    process.exitCode = reportFailure(cause)
  }
}
