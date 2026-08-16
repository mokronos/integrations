import { chmodSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { integrationsHome } from "./paths.ts"

/** The dashboard already owns 4787. */
export const defaultGatewayPort = 4788

/** How long invocation arguments are kept in the audit trail. The record they
 *  hang off is permanent; these are where the PII lives and their forensic
 *  value decays within days, so they age out separately. */
export const defaultArgumentRetentionDays = 30

/** How long a frozen invocation waits for a human before it is a decision. */
export const defaultApprovalExpiryHours = 24

/** Written by the daemon, read by clients on the same machine. Holds the port
 * and a key, so the local case is zero-configuration and the sandbox case is
 * explicit.
 *
 * Mode 0600: this file is a credential. */
export const GatewayConfigFile = Schema.Struct({
  port: Schema.Number,
  url: Schema.String,
  apiKey: Schema.String
})
export type GatewayConfigFile = typeof GatewayConfigFile.Type

export const gatewayConfigPath = (home: string): string =>
  path.join(home, "gateway.json")

const decodeConfig = Schema.decodeUnknownSync(GatewayConfigFile)

export const writeGatewayConfig = async (
  home: string,
  config: GatewayConfigFile
): Promise<void> => {
  const location = gatewayConfigPath(home)
  await mkdir(path.dirname(location), { recursive: true, mode: 0o700 })
  await writeFile(location, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  // writeFile only applies the mode when creating, so an existing file keeps
  // whatever it had. Re-assert it.
  chmodSync(location, 0o600)
}

export const readGatewayConfig = async (
  home: string
): Promise<GatewayConfigFile | undefined> => {
  try {
    return decodeConfig(JSON.parse(await readFile(gatewayConfigPath(home), "utf8")))
  } catch {
    return undefined
  }
}

export interface ClientConnection {
  readonly url: string
  readonly apiKey: string
}

/** How a client finds the gateway: explicit environment first, then the config
 *  file the local daemon wrote. Environment wins so a sandbox can be pointed at
 *  a remote gateway without touching disk. */
export const resolveClientConnection = async (
  environment: NodeJS.ProcessEnv = process.env
): Promise<ClientConnection | undefined> => {
  const url = environment["INTEGRATIONS_URL"]
  const apiKey = environment["INTEGRATIONS_API_KEY"]
  if (url !== undefined && url.length > 0 && apiKey !== undefined && apiKey.length > 0) {
    return { url, apiKey }
  }
  const config = await readGatewayConfig(integrationsHome(environment))
  return config === undefined ? undefined : { url: config.url, apiKey: config.apiKey }
}
