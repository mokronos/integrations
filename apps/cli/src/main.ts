#!/usr/bin/env bun
import { BunHttpClient, BunServices } from "@effect/platform-bun"
import { Data, Effect, Layer } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { HttpClient } from "effect/unstable/http"
import { defaultGatewayPort } from "@mokronos/integrations-client"
import { telemetryLayer } from "@mokronos/observability"
import { controlPlaneSubcommands, operatorClientSubcommands } from "./commands.ts"
import { authenticationSubcommands } from "./auth-commands.ts"
import { openBrowser } from "./connection.ts"
import { writeStdoutLine } from "./output.ts"
import {
  installService,
  serviceLabel,
  serviceProgram,
  startDetachedGateway,
  uninstallService
} from "./service.ts"
import packageMetadata from "../package.json" with { type: "json" }

class ServeError extends Data.TaggedError("ServeError")<{ readonly message: string }> {}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
const serveError = (error: unknown): ServeError =>
  new ServeError({ message: error instanceof Error ? error.message : String(error) })

const loopbackWarning = (host: string): void => {
  if (host !== "127.0.0.1") {
    console.error(
      "Warning: binding outside loopback exposes a credential that unlocks every connection. Terminate TLS in front of it."
    )
  }
}

const runForeground = async (port: number, host: string): Promise<void> => {
  const { serveGateway } = await import("@mokronos/integrations-local")
  const running = await serveGateway({ port, hostname: host, httpClient: BunHttpClient.layer })
  await Effect.runPromise(writeStdoutLine(`integrations gateway listening at ${running.url}`))
  loopbackWarning(host)
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void running.stop().then(resolve)
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
}

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
    ),
    detach: Flag.boolean("detach").pipe(
      Flag.withDefault(false),
      Flag.withAlias("d"),
      Flag.withDescription(
        "Start in the background and return, waiting until the gateway is ready"
      )
    )
  },
  ({ port, host, detach }) =>
    Effect.gen(function*() {
      if (!detach) {
        return yield* Effect.tryPromise({
          try: () => runForeground(port, host),
          catch: serveError
        })
      }
      const started = yield* startDetachedGateway({ program: serviceProgram(), port, host })
      loopbackWarning(host)
      yield* writeStdoutLine(
        `integrations gateway listening at ${started.url} (pid ${started.pid})\nlogs: ${started.logPath}\nstop: kill ${started.pid}\nAt login too: ii install`
      )
    })
).pipe(Command.withDescription("Run the integration gateway, in this terminal or detached"))

const dashboardCommand = Command.make(
  "dashboard",
  {
    print: Flag.boolean("print").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the URL instead of opening a browser")
    )
  },
  ({ print }) =>
    Effect.gen(function*() {
      const { readGatewayConfig, integrationsHome } = yield* Effect.promise(() =>
        import("@mokronos/integrations-client")
      )
      const config = yield* Effect.promise(() => readGatewayConfig(integrationsHome()))
      if (config === undefined) {
        return yield* new ServeError({
          message: "No gateway found. Start one with `ii serve`, then try again."
        })
      }
      const healthy = yield* HttpClient.get(`${config.url}/v1/health`).pipe(
        Effect.match({
          onFailure: () => false,
          onSuccess: (response) => response.status >= 200 && response.status < 300
        })
      )
      if (!healthy) {
        return yield* new ServeError({
          message: `Nothing is answering at ${config.url}. Start the gateway with \`ii serve\`.`
        })
      }
      if (!print) openBrowser(config.url)
      yield* writeStdoutLine(
        print ? config.url : `Opening the control plane at ${config.url}`
      )
    })
).pipe(Command.withDescription("Open the gateway's control plane in a browser"))

const installCommand = Command.make(
  "install",
  {
    port: Flag.integer("port").pipe(
      Flag.withDefault(defaultGatewayPort),
      Flag.withDescription(`Port the service listens on (default: ${defaultGatewayPort})`)
    ),
    verbose: Flag.boolean("verbose").pipe(
      Flag.withDefault(false),
      Flag.withAlias("v"),
      Flag.withDescription("Show service-manager output")
    )
  },
  ({ port, verbose }) =>
    installService({ program: serviceProgram(), port, verbose }).pipe(
      Effect.flatMap((descriptor) =>
        writeStdoutLine(
          `integrations gateway service installed and started as ${serviceLabel} at http://127.0.0.1:${descriptor.port}\nRemove it with: ii uninstall`
        )
      )
    )
).pipe(Command.withDescription("Register and start the gateway as a per-user service"))

const uninstallCommand = Command.make(
  "uninstall",
  {
    verbose: Flag.boolean("verbose").pipe(
      Flag.withDefault(false),
      Flag.withAlias("v"),
      Flag.withDescription("Show service-manager output")
    )
  },
  ({ verbose }) =>
    Effect.tryPromise({
      try: async () => {
        await uninstallService(verbose)
        await Effect.runPromise(writeStdoutLine(
          `${serviceLabel} stopped and deregistered. Connections and credentials were left in place.`
        ))
      },
      catch: serveError
    })
).pipe(Command.withDescription("Stop and deregister the gateway service"))

export const rootCommand = Command.make("ii").pipe(
  Command.withDescription(
    "Discover, authorize, delegate, and invoke integrations through the gateway"
  ),
  Command.withSubcommands([
    ...operatorClientSubcommands,
    ...controlPlaneSubcommands,
    ...authenticationSubcommands,
    serveCommand,
    dashboardCommand,
    installCommand,
    uninstallCommand
  ])
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
      Effect.provide(Layer.mergeAll(
        BunServices.layer,
        BunHttpClient.layer,
        telemetryLayer({ serviceName: "integrations-cli" })
      ))
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
