import {
  defaultArgumentRetentionDays,
  defaultGatewayPort,
  writeGatewayConfig
} from "./config.ts"
import { whenPresent } from "@mokronos/wfkit/optional"
import { defaultTenantId } from "./domain.ts"
import { resolveEncryption } from "./crypto.ts"
import type { Gateway } from "./host.ts"
import { createGatewayHandler } from "./http/handler.ts"
import type { GatewayRequestContext } from "./http/handler.ts"
import { isLoopbackAddress, mayBorrowLocalCredential } from "./http/loopback.ts"
import { gatewayRoutes } from "./http/api.ts"
import { startMaintenanceLoop } from "./maintenance.ts"
import type { MaintenanceLoop } from "./maintenance.ts"
import { createOAuthSessions } from "./oauth-sessions.ts"
import type { OAuthSessionStore } from "./oauth-sessions.ts"
import { createRateLimiter } from "./ratelimit.ts"
import { generateApiKey, newClientId } from "./keys.ts"
import { integrationsHome } from "./paths.ts"
import type { ExecutorHostStorage } from "@mokronos/wfkit-executor"
import type { GatewayStoreInitializationError, GatewayStoreOptions } from "./store.ts"
import type { GatewayStore } from "./store.ts"
import { GatewayStoreService } from "./store.ts"
import { createWebAssets } from "./web-assets.ts"
import {
  ExecutorHostService,
  ExecutorServicesService
} from "@mokronos/wfkit-executor"
import { Effect, Layer, ManagedRuntime } from "effect"

/** The client the local machine uses. Created on first start with mayMutate so
 *  an agent authoring workflows can discover and connect, with the human needed
 *  only for the one auth step. Keys issued to sandboxes do not get this. */
export const localClientName = "local"

export interface GatewayService {
  readonly home: string
  readonly store: GatewayStore
  readonly gateway: Gateway
  readonly handle: (request: Request, context?: GatewayRequestContext) => Promise<Response>
  close(): Promise<void>
}

export interface GatewayServiceOptions {
  readonly home?: string
  readonly retentionDays?: number
  /** Overrides integrations.sh for a private or test registry. */
  readonly registryUrl?: string
  /** The gateway's externally reachable origin, e.g. https://gw.example.com.
   *  Set on a hosted deployment so OAuth callbacks arrive at the gateway's own
   *  public URL instead of an ephemeral loopback listener. */
  readonly publicUrl?: string
  /** Loopback origin of this very process, e.g. http://127.0.0.1:4788. Used as
   *  the OAuth callback origin when no publicUrl is configured, so the redirect
   *  URI is stable enough to pre-register at providers that demand an exact one
   *  (Google, Microsoft) before any flow starts. */
  readonly localCallbackOrigin?: string
  /** Set when the socket is bound off loopback, so session cookies carry
   *  `Secure` and a stolen cookie is worth less on the wire. */
  readonly secureCookies?: boolean
  /** Per-principal request budget per minute; falls back to
   *  INTEGRATIONS_RATE_LIMIT, then {@link defaultRateLimitPerMinute}. */
  readonly rateLimitPerMinute?: number
  /** Largest accepted JSON body in bytes; defaults to one mebibyte. */
  readonly maxBodyBytes?: number
  // --- deployment seams ------------------------------------------------------
  // A gateway whose storage is not a directory on disk — Cloudflare Workers
  // with a D1 binding, an integration test — supplies these instead of the
  // file-backed defaults. Everything unset keeps the historical behaviour.
  /** Replaces the file SQLite store layer entirely. When given, `home` is
   *  neither created nor read for storage. */
  readonly storeLayer?: Layer.Layer<GatewayStoreService, GatewayStoreInitializationError>
  /** Storage overrides forwarded to the Executor host (credential provider
   *  and database). See {@link ExecutorHostStorage}. */
  readonly executorStorage?: ExecutorHostStorage
  /** Shared OAuth session storage for deployments that serve requests from
   *  more than one process. Absent keeps sessions in memory. */
  readonly oauthStore?: OAuthSessionStore
  /** Options forwarded to {@link GatewayStoreService.layer} when no explicit
   *  storeLayer is supplied. */
  readonly storeOptions?: GatewayStoreOptions
  /** Set on deployments whose clock lives outside the process — a Workers
   *  cron trigger calls runMaintenance(store) itself — so no in-process
   *  interval runs. */
  readonly externalMaintenance?: boolean
}

/** Signup is open exactly while the gateway has no humans at all — its first
 *  login claims the instance — or when an operator opts in explicitly. */
const signupOpen = async (
  store: GatewayStore,
  environment: NodeJS.ProcessEnv = process.env
): Promise<boolean> =>
  environment["INTEGRATIONS_ALLOW_SIGNUP"] === "1" || await store.countLogins() === 0

/** Requests per minute one client or signed-in human may make. The address
 *  bucket that guards unauthenticated traffic is a fraction of this, since a
 *  credential guesser has no principal to be generous to. */
export const defaultRateLimitPerMinute = 600

export const createGatewayService = async (
  options: GatewayServiceOptions = {}
): Promise<GatewayService> => {
  const home = options.home ?? integrationsHome()
  // Payloads at rest are sealed when a master key is available: from the
  // environment, or a keyfile created inside `home` on first start. An
  // unconfigured local gateway stays plaintext — same behaviour as always.
  const encryption = await resolveEncryption({
    ...whenPresent("envValue", process.env["INTEGRATIONS_MASTER_KEY"]),
    keyFile: `${home}/gateway.key`
  })
  const dependencies = ManagedRuntime.make(Layer.merge(
    options.storeLayer ??
      GatewayStoreService.layer(`${home}/gateway.sqlite`, encryption, options.storeOptions),
    ExecutorServicesService.layerWithHost(home, options.executorStorage)
  ))
  try {
    const resources = await dependencies.runPromise(Effect.gen(function* () {
      const store = yield* GatewayStoreService
      const host = yield* ExecutorHostService
      const executor = yield* ExecutorServicesService
      return { store, host, executor }
    }))
    const gateway: Gateway = {
      directory: resources.host.directory,
      host: resources.host,
      executor: resources.executor,
      close: () => resources.host.close()
    }
    // Read at flow-start time, not construction time: the local origin is only
    // known once serveGateway has decided how the socket is bound. The callback
    // route is GET /v1/oauth/callback either way.
    const resolvePublicUrl = (): string | undefined =>
      options.publicUrl ?? process.env["INTEGRATIONS_PUBLIC_URL"] ??
        options.localCallbackOrigin
    const oauth = createOAuthSessions(gateway.executor, {
      publicUrlOf: resolvePublicUrl,
      ...whenPresent("store", options.oauthStore)
    })
    const maintenance: MaintenanceLoop | undefined =
      options.externalMaintenance === true ? undefined : startMaintenanceLoop(resources.store)
    const routes = gatewayRoutes({
      store: resources.store,
      executor: gateway.executor,
      retentionDays: options.retentionDays ?? defaultArgumentRetentionDays,
      oauth,
      oauthCallbackUrl: () => {
        const origin = resolvePublicUrl()
        return origin === undefined ? undefined : `${origin.replace(/\/+$/, "")}/v1/oauth/callback`
      },
      sessions: {
        signupOpen: await signupOpen(resources.store),
        secureCookies: options.secureCookies ?? false
      },
      ...whenPresent("registryUrl", options.registryUrl)
    })
    let closed = false
    const perMinute = options.rateLimitPerMinute ??
      Number.parseInt(process.env["INTEGRATIONS_RATE_LIMIT"] ?? "", 10)
    const rateLimiter = createRateLimiter({
      // The principal bucket is the configured budget; the address bucket that
      // guards unauthenticated traffic is a fifth of it, floored so a tiny
      // configured limit still leaves credential guessing meaningfully bounded.
      limit: Number.isFinite(perMinute) && perMinute > 0 ? perMinute : defaultRateLimitPerMinute,
      windowMs: 60_000
    })
    const addressLimiter = createRateLimiter({
      limit: Math.max(20, Math.floor((Number.isFinite(perMinute) && perMinute > 0
        ? perMinute
        : defaultRateLimitPerMinute) / 5)),
      windowMs: 60_000
    })
    return {
      home,
      store: resources.store,
      gateway,
      handle: createGatewayHandler({
        store: resources.store,
        routes,
        rateLimiter,
        addressRateLimiter: addressLimiter,
        ...whenPresent("maxBodyBytes", options.maxBodyBytes)
      }),
      close: async () => {
        if (closed) return
        closed = true
        maintenance?.stop()
        oauth.stop()
        await dependencies.dispose()
      }
    }
  } catch (error) {
    await dependencies.dispose()
    throw error
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
  const existing = await service.store.findClientByName(defaultTenantId, localClientName)
  const client = existing ?? await service.store.createClient({
    id: newClientId(),
    tenantId: defaultTenantId,
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
  /** Overrides integrations.sh for a private or test registry. */
  readonly registryUrl?: string
  /** Serve the control plane at `/`. On by default; a headless gateway can turn
   *  it off so the only thing on the port is the API. */
  readonly web?: boolean
}

export interface RunningGateway {
  readonly port: number
  readonly url: string
  readonly service: GatewayService
  /** Where the control plane is being served from, or `undefined` when it is
   *  not being served at all. */
  readonly web: string | undefined
  stop(): Promise<void>
}

/** Binds to 127.0.0.1 unless told otherwise. What crosses this wire is a
 * credential that unlocks every connection a client holds, so exposing it
 * externally has to be a deliberate act rather than a default. */
export const serveGateway = async (options: ServeOptions = {}): Promise<RunningGateway> => {
  const hostname = options.hostname ?? "127.0.0.1"
  const boundToLoopback = isLoopbackAddress(hostname)
  // The port is deterministic — Bun.serve would fail rather than relocate a
  // busy port — so the OAuth redirect URI can be computed before binding.
  // Port 0 means the OS picks, which is unregistrable at providers that want
  // an exact redirect URI, so no local callback origin applies there.
  const requestedPort = options.port ?? defaultGatewayPort
  const service = await createGatewayService({
    ...whenPresent("home", options.home),
    ...whenPresent("registryUrl", options.registryUrl),
    secureCookies: !boundToLoopback,
    ...whenPresent(
      "localCallbackOrigin",
      boundToLoopback && requestedPort !== 0
        ? `http://${hostname}:${requestedPort}`
        : undefined
    )
  })
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    const web = options.web === false ? undefined : await createWebAssets()

    // The local key is minted below, once the port is known. Until then there is
    // nothing to borrow and a browser gets the same 401 as anyone else.
    let localSecret: string | undefined

    server = Bun.serve({
      hostname,
      port: requestedPort,
      fetch: async (request, running) => {
        const pathname = new URL(request.url).pathname
        if (web !== undefined && !pathname.startsWith("/v1/")) {
          const asset = await web.respond(pathname)
          if (asset !== undefined) return asset
        }
        const local = localSecret
        const borrow = local !== undefined && mayBorrowLocalCredential(request, {
          boundToLoopback,
          port: Number(running.port),
          remoteAddress: running.requestIP(request)?.address
        })
        const requestContext: GatewayRequestContext = {
          ...whenPresent("remoteAddress", running.requestIP(request)?.address),
          ...whenPresent("localSecret", borrow && local !== undefined ? local : undefined)
        }
        return await service.handle(request, requestContext)
      }
    })
    const boundPort = Number(server.port)
    localSecret = await ensureLocalCredential(service, boundPort)
    let stopped = false
    return {
      port: boundPort,
      url: `http://${hostname}:${boundPort}`,
      service,
      web: web?.directory,
      stop: async () => {
        if (stopped) return
        stopped = true
        server?.stop(true)
        await service.close()
      }
    }

  } catch (error) {
    server?.stop(true)
    await service.close()
    throw error
  }
}
