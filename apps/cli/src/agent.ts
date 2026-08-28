#!/usr/bin/env bun
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { telemetryLayer } from "@mokronos/observability"
import { clientSubcommands } from "./commands.ts"
import packageMetadata from "../package.json" with { type: "json" }

export const rootCommand = Command.make("i").pipe(
  Command.withDescription(
    "Discover, connect, and invoke integrations"
  ),
  Command.withSubcommands(clientSubcommands)
)

export const main = async (argv: ReadonlyArray<string>): Promise<void> => {
  await Effect.runPromise(
    Command.runWith(rootCommand, { version: packageMetadata.version })(argv).pipe(
      Effect.catchTag("ShowHelp", (error) =>
        error.errors.length === 0
          ? Effect.void
          : Effect.sync(() => {
            process.exitCode = 1
          })),
      Effect.provide(Layer.merge(
        BunServices.layer,
        telemetryLayer({ serviceName: "integrations-agent-cli" })
      ))
    )
  )
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
    process.exitCode = process.exitCode ?? 0
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  }
}
