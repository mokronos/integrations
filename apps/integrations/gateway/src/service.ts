import {
  defaultArgumentRetentionDays,
  defaultGatewayPort,
  writeGatewayConfig
} from "./config.ts"
import { createGateway } from "./host.ts"
import type { Gateway } from "./host.ts"
import { createGatewayHandler } from "./http/handler.ts"
import { makeRoutes } from "./http/api.ts"
import { createOAuthSessions } from "./oauth-sessions.ts"
import { generateApiKey, newClientId } from "./keys.ts"
import { integrationsHome } from "./paths.ts"
import { createGatewayStore } from "./store.ts"
import type { GatewayStore } from "./store.ts"

/** The client the local machine uses. Created on first start with mayMutate so
 *  an agent authoring workflows can discover and connect, with the human needed
 *  only for the one auth step. Keys issued to sandboxes do not get this. */
export const localClientName = "local"

export interface GatewayService {
  readonly home: string
  readonly store: GatewayStore
  readonly gateway: Gateway
  readonly handle: (request: Request) => Promise<Response>
  close(): Promise<void>
}

export interface GatewayServiceOptions {
  readonly home?: string
  readonly retentionDays?: number
}

export const createGatewayService = async (
  options: GatewayServiceOptions = {}
): Promise<GatewayService> => {
  const home = options.home ?? integrationsHome()
  const store = await createGatewayStore(`${home}/gateway.sqlite`)
  const gateway = createGateway({ directory: home })
  const oauth = createOAuthSessions(gateway.executor)
  const routes = makeRoutes({
    store,
    executor: gateway.executor,
    retentionDays: options.retentionDays ?? defaultArgumentRetentionDays,
    oauth
  })
  return {
    home,
    store,
    gateway,
    handle: createGatewayHandler({ store, routes }),
    close: async () => {
      oauth.stop()
      await gateway.close()
      await store.close()
    }
  }
}

/** Ensures the local client exists and has a live key, then records where the
 * gateway is listening. Idempotent apart from key issue: a fresh key is minted
 * whenever the recorded one is missing, so losing the config file is
 * recoverable without losing the client's grants. */
export const ensureLocalCredential = async (
  service: GatewayService,
  port: number
): Promise<string> => {
  const existing = await service.store.findClientByName(localClientName)
  const client = existing ?? await service.store.createClient({
    id: newClientId(),
    name: localClientName,
    mayMutate: true
  })
  const key = generateApiKey()
  await service.store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash })
  await writeGatewayConfig(service.home, {
    port,
    url: `http://127.0.0.1:${port}`,
    apiKey: key.secret
  })
  return key.secret
}

export interface ServeOptions {
  readonly port?: number
  readonly hostname?: string
  readonly home?: string
}

export interface RunningGateway {
  readonly port: number
  readonly url: string
  readonly service: GatewayService
  stop(): Promise<void>
}

/** Binds to 127.0.0.1 unless told otherwise. What crosses this wire is a
 * credential that unlocks every connection a client holds, so exposing it
 * externally has to be a deliberate act rather than a default. */
export const serveGateway = async (options: ServeOptions = {}): Promise<RunningGateway> => {
  const service = await createGatewayService(
    options.home === undefined ? {} : { home: options.home }
  )
  const hostname = options.hostname ?? "127.0.0.1"
  const server = Bun.serve({
    hostname,
    port: options.port ?? defaultGatewayPort,
    fetch: (request) => service.handle(request)
  })
  const port = Number(server.port)
  await ensureLocalCredential(service, port)
  return {
    port,
    url: `http://${hostname}:${port}`,
    service,
    stop: async () => {
      server.stop(true)
      await service.close()
    }
  }
}
