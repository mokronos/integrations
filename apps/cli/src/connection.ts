import { Data, Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { HttpClient } from "effect/http"
import { makeGatewayClient, resolveClientConnection } from "@integragents/client"
import type { GatewayClient } from "@integragents/client"

export class IntegrationsCliError extends Data.TaggedError("IntegrationsCliError")<{
  readonly message: string
}> {}

export const cliError = (message: string): IntegrationsCliError => new IntegrationsCliError({ message })

/** The text of a value something threw, which is not always an `Error`. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const thrownMessage = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown))

export const connectToGateway = Effect.fn("Cli.connectToGateway")(function* (): Effect.fn.Return<
  GatewayClient,
  IntegrationsCliError,
  HttpClient.HttpClient
> {
  const connection = yield* Effect.promise(() => resolveClientConnection())
  if (connection === undefined) {
    return yield* cliError(
      "No integrations gateway configured. Set INTEGRATIONS_URL and INTEGRATIONS_API_KEY, or start the local gateway with `ii serve`."
    )
  }
  return yield* makeGatewayClient(connection)
})

/**
 * Hands the URL to the desktop and stops caring. A host with no browser, or
 * none we know how to ask, is not a reason to fail the command — the URL was
 * printed either way.
 */
export const openBrowser = (url: string): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const [program, ...arguments_] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url]
  return Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    Effect.asVoid(
      Effect.forkDetach(
        Effect.ignore(
          spawner.exitCode(
            ChildProcess.make(program ?? "xdg-open", arguments_, {
              stdout: "ignore",
              stderr: "ignore"
            })
          )
        )
      )
    )
  )
}
