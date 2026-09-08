import { chmodSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

export const defaultGatewayPort = 4788

export const integrationsHome = (
  environment: NodeJS.ProcessEnv = process.env
): string => {
  const configured = environment["INTEGRATIONS_HOME"]
  return configured === undefined || configured.length === 0
    ? path.join(homedir(), ".integrations")
    : path.resolve(configured)
}

export const GatewayConfigFile = Schema.Struct({
  port: Schema.Number,
  url: Schema.String,
  apiKey: Schema.String,
  pid: Schema.optional(Schema.Number)
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
  chmodSync(location, 0o600)
}

export interface ClientConnection {
  readonly url: string
  readonly apiKey: string
}

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
