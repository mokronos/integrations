import { Data } from "effect"
import { createGatewayClient, GatewayError, resolveClientConnection } from "@mokronos/integrations-client"
import type { GatewayClient } from "@mokronos/integrations-client"

export class IntegrationsCliError extends Data.TaggedError("IntegrationsCliError")<{
  readonly message: string
}> {}

export const cliError = (message: string): IntegrationsCliError =>
  new IntegrationsCliError({ message })

export const describeError = (error: unknown): string => {
  if (error instanceof IntegrationsCliError) return error.message
  if (error instanceof GatewayError) {
    // A capability refusal is the one failure worth explaining rather than
    // restating, because the fix is a different key, not a different request.
    return error.status === 403
      ? `${error.message} (this key is not permitted; use a key whose client may mutate)`
      : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** Every command goes through the gateway; there is no local fallback. If the
 * daemon is not running there is nothing sensible to do, because the
 * credentials live behind it. */
export const connectToGateway = async (): Promise<GatewayClient> => {
  const connection = await resolveClientConnection()
  if (connection === undefined) {
    throw cliError(
      "No gateway found. Start one with `integrations serve`, or set INTEGRATIONS_URL and INTEGRATIONS_API_KEY."
    )
  }
  return createGatewayClient(connection)
}

export const openBrowser = (url: string): void => {
  const command = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url]
  Bun.spawn(command, { stdout: "ignore", stderr: "ignore" })
}
