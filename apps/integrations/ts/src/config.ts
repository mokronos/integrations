import { chmodSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

/** The dashboard already owns 4787. */
export const defaultGatewayPort = 4788

/** Where the gateway keeps credentials, the catalog, and its own store.
 *
 * `WF_HOME` is still honoured because the directory has not moved on disk —
 * the gateway took ownership of resolving it, not of relocating it. */
export const integrationsHome = (
  environment: NodeJS.ProcessEnv = process.env
): string => {
  const configured = environment["INTEGRATIONS_HOME"] ?? environment["WF_HOME"]
  return configured === undefined || configured.length === 0
    ? path.join(homedir(), ".wf")
    : path.resolve(configured)
}

/** Written by the daemon, read by clients on the same machine. Holds the port
 * and a key, so the local case is zero-configuration and the sandbox case is
 * explicit.
 *
 * This lives in the client package because finding the gateway is a client
 * concern; the gateway depends on it only to record where it is listening. */
export const GatewayConfigFile = Schema.Struct({
  port: Schema.Number,
  url: Schema.String,
  apiKey: Schema.String
})
export type GatewayConfigFile = typeof GatewayConfigFile.Type

export const gatewayConfigPath = (home: string): string =>
  path.join(home, "gateway.json")

const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(GatewayConfigFile))

export const readGatewayConfig = async (
  home: string
): Promise<GatewayConfigFile | undefined> => {
  try {
    return decodeConfig(await readFile(gatewayConfigPath(home), "utf8"))
  } catch {
    return undefined
  }
}

export const writeGatewayConfig = async (
  home: string,
  config: GatewayConfigFile
): Promise<void> => {
  const location = gatewayConfigPath(home)
  await mkdir(path.dirname(location), { recursive: true, mode: 0o700 })
  await writeFile(location, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  // writeFile only applies the mode when creating, so an existing file keeps
  // whatever it had. This file is a credential — re-assert it.
  chmodSync(location, 0o600)
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
