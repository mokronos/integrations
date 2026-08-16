#!/usr/bin/env bun
import { BunServices } from "@effect/platform-bun"
import { Data, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { defaultGatewayPort } from "@mokronos/integrations-client"
import { integrationsSubcommands } from "./commands.ts"
import { writeStdoutLine } from "./output.ts"
import packageMetadata from "../package.json" with { type: "json" }

/** Starting the gateway is the one command that does not go through a gateway,
 * for the obvious reason. It is here rather than in `wf` because the gateway is
 * the integrations product — `wf` depends on it, not the other way round. */
class ServeError extends Data.TaggedError("ServeError")<{ readonly message: string }> {}

const serveCommand = Command.make(
  "serve",
  {
    port: Flag.integer("port").pipe(
      Flag.withDefault(defaultGatewayPort),
      Flag.withDescription(`Port to listen on (default: ${defaultGatewayPort})`)
    ),
    host: Flag.string("host").pipe(
      Flag.withDefault("127.0.0.1"),
      Flag.withDescription("Bind address. Anything other than loopback exposes credentials")
    )
  },
  ({ port, host }) =>
    Effect.tryPromise({
      try: async () => {
        // Imported lazily so every other command stays independent of the
        // gateway package — the CLI is a thin client by construction.
        const { serveGateway } = await import("@mokronos/integrations")
        const running = await serveGateway({ port, hostname: host })
        await Effect.runPromise(
          writeStdoutLine(`integrations gateway listening at ${running.url}`)
        )
        if (host !== "127.0.0.1") {
          console.error(
            "Warning: binding outside loopback exposes a credential that unlocks every connection. Terminate TLS in front of it."
          )
        }
        await new Promise<void>((resolve) => {
          const stop = (): void => {
            void running.stop().then(resolve)
          }
          process.once("SIGINT", stop)
          process.once("SIGTERM", stop)
        })
      },
      catch: (error) =>
        new ServeError({ message: error instanceof Error ? error.message : String(error) })
    })
).pipe(Command.withDescription("Run the integration gateway in the foreground"))

const rootCommand = Command.make("integrations").pipe(
  Command.withDescription(
    "Discover, authorize, delegate, and invoke integrations through the gateway"
  ),
  Command.withSubcommands([...integrationsSubcommands, serveCommand])
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
      Effect.provide(BunServices.layer)
    )
  )
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
    process.exitCode = process.exitCode ?? 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
