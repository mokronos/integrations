import { Data, Effect, Predicate } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { HttpClient } from "effect/unstable/http"
import { makeGatewayClient, resolveClientConnection } from "@mokronos/integrations-client"
import { Forbidden } from "@mokronos/integrations-gateway-api"
import type { GatewayClient } from "@mokronos/integrations-client"

export class IntegrationsCliError extends Data.TaggedError("IntegrationsCliError")<{
  readonly message: string
}> {}

export const cliError = (message: string): IntegrationsCliError =>
  new IntegrationsCliError({ message })

// The gateway routes spell their human-readable text `error`, not `message`,
// so an Error carrying one reads as empty until it is asked for by name.
const explains = (failure: Error): failure is Error & { readonly error: string } =>
  "error" in failure && Predicate.isString(failure.error) && failure.error.length > 0

// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const describeError = (error: unknown): string => {
  if (error instanceof IntegrationsCliError) return error.message
  // A capability refusal is the one gateway error worth explaining: the
  // credential was accepted, it just is not allowed to do this.
  if (error instanceof Forbidden && error.code === "not-permitted") {
    return `${error.message} (use a client or human session with the required capability)`
  }
  if (!(error instanceof Error)) return String(error)
  if (error.message.length > 0) return error.message
  return explains(error) ? error.error : String(error)
}

export const connectToGateway = Effect.fn("cli.connectToGateway")(function*(): Effect.fn.Return<
  GatewayClient,
  IntegrationsCliError,
  HttpClient.HttpClient
> {
  const connection = yield* Effect.promise(() => resolveClientConnection())
  if (connection === undefined) {
    return yield* cliError(
      "No integrations service found. Set INTEGRATIONS_URL and INTEGRATIONS_API_KEY."
    )
  }
  return yield* makeGatewayClient(connection)
})

/**
 * Hands the URL to the desktop and stops caring. A host with no browser, or
 * none we know how to ask, is not a reason to fail the command — the URL was
 * printed either way.
 */
export const openBrowser = (
  url: string
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const [program, ...arguments_] = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url]
  return Effect.flatMap(
    ChildProcessSpawner.ChildProcessSpawner,
    (spawner) =>
      Effect.asVoid(Effect.forkDetach(Effect.ignore(
        spawner.exitCode(ChildProcess.make(program ?? "xdg-open", arguments_, {
          stdout: "ignore",
          stderr: "ignore"
        }))
      )))
  )
}
