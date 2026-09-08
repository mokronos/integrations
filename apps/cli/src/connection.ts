import { Data, Predicate } from "effect"
import { createGatewayClient, GatewayError, resolveClientConnection } from "@mokronos/integrations-client"
import type { GatewayClient } from "@mokronos/integrations-client"

export class IntegrationsCliError extends Data.TaggedError("IntegrationsCliError")<{
  readonly message: string
}> {}

export const cliError = (message: string): IntegrationsCliError =>
  new IntegrationsCliError({ message })

const isCapabilityRefusal = (error: GatewayError): boolean =>
  error.status === 403 &&
  Predicate.isObjectOrArray(error.body) &&
  "code" in error.body &&
  error.body["code"] === "not-permitted"

// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const describeError = (error: unknown): string => {
  if (error instanceof IntegrationsCliError) return error.message
  if (error instanceof GatewayError) {
    return isCapabilityRefusal(error)
      ? `${error.message} (use a client or human session with the required capability)`
      : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

export const connectToGateway = async (): Promise<GatewayClient> => {
  const connection = await resolveClientConnection()
  if (connection === undefined) {
    throw cliError(
      "No integrations service found. Set INTEGRATIONS_URL and INTEGRATIONS_API_KEY."
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
