import {
  defaultArgumentRetentionDays,
  defaultGatewayPort,
  writeGatewayConfig
} from "@mokronos/gateway-core"
import { PositiveInt, PositiveIntFromString, whenPresent } from "@mokronos/contracts"
import { defaultTenantId } from "@mokronos/gateway-core"
import { resolveEncryption } from "@mokronos/gateway-core"
import type { Gateway } from "@mokronos/gateway-core"
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { isLoopbackAddress, mayBorrowLocalCredential } from "./http/loopback.ts"
import { createGatewayHandler } from "./http/handler.ts"
import type { GatewayHandle, GatewayRequestContext } from "./http/handler.ts"
import { startMaintenanceLoop } from "@mokronos/gateway-core"
import type { MaintenanceLoop } from "@mokronos/gateway-core"
import { createOAuthSessions } from "@mokronos/gateway-core"
import { grantConnectedTools } from "@mokronos/gateway-core"
import type { OAuthSessionStore } from "@mokronos/gateway-core"
import { createRateLimiter } from "@mokronos/gateway-core"
import { generateApiKey, newClientId } from "@mokronos/gateway-core"
import { integrationsHome } from "./paths.ts"
import type { HostStorage } from "@mokronos/integrations"
import { HostHandleService, IntegrationsApiService } from "@mokronos/integrations"
import type { GatewayStoreError, GatewayStoreOptions } from "@mokronos/gateway-core"
import type { GatewayStore } from "@mokronos/gateway-core"
import { GatewayStoreService } from "@mokronos/gateway-core"
import { createWebAssets } from "./web-assets.ts"
import { telemetryLayer } from "@mokronos/observability"
import type { GoogleIdentityOAuth } from "@mokronos/gateway-core"

/** The client the local machine uses. Created with both client capabilities so
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
  /** OAuth client used for human control-plane sign-in. This is deliberately
   * separate from vendor integration OAuth credentials. */
  readonly googleIdentity?: Pick<GoogleIdentityOAuth, "clientId" | "clientSecret" | "fetch">
  /** Loopback origin of this very process, e.g. http://127.0.0.1:4788. Used as
   *  the OAuth callback origin when no publicUrl is configured, so the redirect
   *  URI is stable enough to pre-register at providers that demand an exact one
   *  (Google, Microsoft) before any flow starts. */
  readonly localCallbackOrigin?: string
  /** Set when the socket is bound off loopback, so session cookies carry
   *  `Secure` and a stolen cookie is worth less on the wire. */
  readonly secureCookies?: boolean
  /** Keeps account creation open after the first human has claimed the
   * instance. Defaults to INTEGRATIONS_ALLOW_SIGNUP=1. */
  readonly allowSignup?: boolean
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
  readonly storeLayer?: Layer.Layer<GatewayStoreService, GatewayStoreError>
  /** Storage overrides forwarded to the integration host (credential store
   *  and database). See {@link HostStorage}. */
  readonly hostStorage?: HostStorage
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
  /** OTLP/HTTP base URL for request tracing (e.g. motel's
   *  http://127.0.0.1:27686). Defaults to INTEGRATIONS_OTLP_ENDPOINT; unset keeps the
   *  gateway untraced with no exporter built. */
  readonly telemetryEndpoint?: string
  /** Extra export headers, e.g. hosted-endpoint auth (`authorization: Basic …`).
   *  Merged over INTEGRATIONS_OTLP_AUTHORIZATION. */
  readonly telemetryHeaders?: Record<string, string>
}

interface GatewayCore {
  readonly home: string
  readonly store: GatewayStore
  readonly gateway: Gateway
  readonly oauth: ReturnType<typeof createOAuthSessions>
  readonly maintenance: MaintenanceLoop | undefined
  readonly handlerOptions: Parameters<typeof createGatewayHandler>[0]
  readonly disposeCore: () => Promise<void>
}

/** Signup is open exactly while the gateway has no humans at all — its first
 *  login claims the instance — or when an operator opts in explicitly. */
const signupOpen = (
  store: GatewayStore,
  explicitlyAllowed = process.env["INTEGRATIONS_ALLOW_SIGNUP"] === "1"
): Effect.Effect<boolean, GatewayStoreError> =>
  explicitlyAllowed ? Effect.succeed(true) : store.countLogins().pipe(Effect.map((count) => count === 0))

const nonBlank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/** Requests per minute one client or signed-in human may make. The address
 *  bucket that guards unauthenticated traffic is a fraction of this, since a
 *  credential guesser has no principal to be generous to. */
export const defaultRateLimitPerMinute = 600

/** Boots storage and the host, and derives every plain value the HTTP surface
 *  closes over. Both serving modes start here, so neither duplicates state. */
const buildCore = async (
  options: GatewayServiceOptions
): Promise<GatewayCore> => {
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
    IntegrationsApiService.layerWithHost(home, options.hostStorage)
  ))
  let resources: Awaited<ReturnType<typeof bootResources>>
  try {
    resources = await bootResources()
  } catch (error) {
    await dependencies.dispose()
    throw error
  }

  /** The one place a service becomes a plain value.
   *
   *  `Gateway` is an async object the CLI and the dashboard hold and close, so
   *  something has to leave Effect here. Everything below this line takes
   *  values; everything above it takes layers, and the HTTP handlers ask the
   *  context for what they need rather than being handed a bag of these. */
  async function bootResources() {
    return await dependencies.runPromise(Effect.gen(function*() {
      const store = yield* GatewayStoreService
      const host = yield* HostHandleService
      const integrations = yield* IntegrationsApiService
      return { store, host, integrations }
    }))
  }

  const gateway: Gateway = {
    directory: resources.host.directory,
    host: resources.host,
    integrations: resources.integrations,
    close: () => resources.host.close()
  }
  // Read at flow-start time, not construction time: the local origin is only
  // known once the caller has decided how the socket is bound. The callback
  // route is GET /v1/oauth/callback either way.
  const resolvePublicUrl = (): string | undefined =>
    options.publicUrl ?? process.env["INTEGRATIONS_PUBLIC_URL"] ??
    options.localCallbackOrigin
  const googleClientId = nonBlank(
    options.googleIdentity?.clientId ?? process.env["INTEGRATIONS_GOOGLE_CLIENT_ID"]
  )
  const googleClientSecret = nonBlank(
    options.googleIdentity?.clientSecret ?? process.env["INTEGRATIONS_GOOGLE_CLIENT_SECRET"]
  )
  if ((googleClientId === undefined) !== (googleClientSecret === undefined)) {
    await dependencies.dispose()
    throw new Error(
      "Google sign-in requires both INTEGRATIONS_GOOGLE_CLIENT_ID and INTEGRATIONS_GOOGLE_CLIENT_SECRET"
    )
  }
  const googleIdentity: GoogleIdentityOAuth | undefined =
    googleClientId === undefined || googleClientSecret === undefined
      ? undefined
      : {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        publicUrlOf: resolvePublicUrl,
        ...whenPresent("fetch", options.googleIdentity?.fetch)
      }
  const oauth = createOAuthSessions(gateway.integrations, {
    publicUrlOf: resolvePublicUrl,
    onConnected: async (session) => {
      if (session.grantClient === undefined || session.state.status !== "connected") return
      await Effect.runPromise(grantConnectedTools({
        store: resources.store,
        integrations: gateway.integrations,
        client: session.grantClient,
        integration: session.integration,
        connection: session.connection
      }))
    },
    ...whenPresent("store", options.oauthStore)
  })
  const maintenance: MaintenanceLoop | undefined =
    options.externalMaintenance === true ? undefined : startMaintenanceLoop(resources.store)

  // The option carries a number and the environment carries text; a budget is
  // a positive whole number either way. Anything else — absent, empty, a typo —
  // is not a budget, and the default stands.
  const perMinute = Option.getOrElse(
    Schema.decodeUnknownOption(Schema.Union([PositiveInt, PositiveIntFromString]))(
      options.rateLimitPerMinute ?? process.env["INTEGRATIONS_RATE_LIMIT"]
    ),
    () => defaultRateLimitPerMinute
  )
  const rateLimiter = createRateLimiter({
    // The principal bucket is the configured budget; the address bucket that
    // guards unauthenticated traffic is a fifth of it, floored so a tiny
    // configured limit still leaves credential guessing meaningfully bounded.
    limit: perMinute,
    windowMs: 60_000
  })
  const addressRateLimiter = createRateLimiter({
    limit: Math.max(20, Math.floor(perMinute / 5)),
    windowMs: 60_000
  })

  const disposeCore = async () => {
    maintenance?.stop()
    await Effect.runPromise(oauth.stop())
    await dependencies.dispose()
  }

  void defaultTenantId

  return {
    home,
    store: resources.store,
    gateway,
    oauth,
    maintenance,
    disposeCore,
    handlerOptions: {
      store: resources.store,
      integrations: gateway.integrations,
      retentionDays: options.retentionDays ?? defaultArgumentRetentionDays,
      oauth,
      oauthCallbackUrl: () => {
        const origin = resolvePublicUrl()
        return origin === undefined
          ? undefined
          : `${origin.replace(/\/+$/, "")}/v1/oauth/callback`
      },
      dashboardUrl: resolvePublicUrl,
      rateLimiter,
      addressRateLimiter,
      observabilityLayer: telemetryLayer({
        serviceName: "integrations-gateway",
        ...whenPresent("endpoint", options.telemetryEndpoint),
        ...whenPresent("headers", options.telemetryHeaders)
      }),
      ...whenPresent("maxBodyBytes", options.maxBodyBytes),
      sessions: {
        signupOpen: () => signupOpen(resources.store, options.allowSignup),
        secureCookies: options.secureCookies ?? false,
        ...whenPresent("google", googleIdentity)
      },
      ...whenPresent("registryUrl", options.registryUrl)
    }
  }
}

export const createGatewayService = async (
  options: GatewayServiceOptions = {}
): Promise<GatewayService> => {
  const core = await buildCore(options)

  // Built eagerly as an object but lazily in substance: the API stack compiles
  // on the first answered request, so a service that never serves HTTP — the
  // Worker's scheduled trigger, tests poking the store — pays nothing for it.
  const handle = createGatewayHandler(core.handlerOptions)
  const dispatch = async (request: Request, context?: GatewayRequestContext): Promise<Response> => {
    const response = await handle.handle(request, context)
    return response
  }

  let closed = false
  return {
    home: core.home,
    store: core.store,
    gateway: core.gateway,
    handle: dispatch,
    close: async () => {
      if (closed) return
      closed = true
      await handle.dispose()
      await core.disposeCore()
    }
  }
}

/** Binds to 127.0.0.1 unless told otherwise. What crosses this wire is a
 *  credential that unlocks every connection a client holds, so exposing it
 *  externally has to be a deliberate act rather than a default. */
export interface ServeOptions {
  readonly port?: number
  readonly hostname?: string
  readonly home?: string
  /** Overrides integrations.sh for a private or test registry. */
  readonly registryUrl?: string
  /** Externally reachable HTTPS origin used for OAuth callbacks in hosted
   *  deployments. The listening socket may still be plain HTTP behind a TLS
   *  terminating reverse proxy. */
  readonly publicUrl?: string
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

export const serveGateway = async (options: ServeOptions = {}): Promise<RunningGateway> => {
  const hostname = options.hostname ?? "127.0.0.1"
  const boundToLoopback = isLoopbackAddress(hostname)
  // The port is deterministic — the listener fails rather than relocates a
  // busy port — so the OAuth redirect URI can be computed before binding.
  // Port 0 means the OS picks, which is unregistrable at providers that want
  // an exact redirect URI, so no local callback origin applies there.
  const requestedPort = options.port ?? defaultGatewayPort
  const core = await buildCore({
    ...options,
    secureCookies: !boundToLoopback,
    ...whenPresent(
      "localCallbackOrigin",
      boundToLoopback && requestedPort !== 0
        ? `http://${hostname}:${requestedPort}`
        : undefined
    )
  })

  try {
    const web = options.web === false ? undefined : await createWebAssets()

    // The local key is minted below, once the port is known. Until then there
    // is nothing to borrow and a browser gets the same 401 as anyone else.
    let localSecret: string | undefined

    const handle: GatewayHandle = createGatewayHandler({
      ...core.handlerOptions,
      ...whenPresent("webAssets", web)
    })

    let server: ReturnType<typeof Bun.serve> | undefined
    let stopped = false

    const service: GatewayService = {
      home: core.home,
      store: core.store,
      gateway: core.gateway,
      handle: (request, context) => handle.handle(request, context),
      close: async () => {
        if (stopped) return
        stopped = true
        server?.stop(true)
        await handle.dispose()
        await core.disposeCore()
      }
    }

    server = Bun.serve({
      hostname,
      port: requestedPort,
      fetch: async (request, running) => {
        const pathname = new URL(request.url).pathname
        if (web !== undefined && !pathname.startsWith("/v1/")) {
          const asset = await web.respond(pathname)
          if (asset !== undefined) return asset
        }
        const remoteAddress = running.requestIP(request)?.address
        const borrow = localSecret !== undefined && mayBorrowLocalCredential(request, {
          boundToLoopback,
          port: Number(running.port),
          remoteAddress
        })
        const requestContext: GatewayRequestContext = {
          ...whenPresent("remoteAddress", remoteAddress),
          ...whenPresent(
            "localSecret",
            borrow && localSecret !== undefined ? localSecret : undefined
          )
        }
        return await service.handle(request, requestContext)
      }
    })

    const boundPort = Number(server.port)
    localSecret = await Effect.runPromise(ensureLocalCredential(core.store, core.home, boundPort))

    return {
      port: boundPort,
      url: `http://${hostname}:${boundPort}`,
      service,
      web: web?.directory,
      stop: () => service.close()
    }
  } catch (error) {
    await core.disposeCore()
    throw error
  }
}

/** Ensures the local client exists and has a live key, then records where the
 *  gateway is listening. Idempotent apart from key issue: a fresh key is minted
 *  whenever the recorded one is missing, so losing the config file is
 *  recoverable without losing the client's grants. */
export const ensureLocalCredential = Effect.fn("Gateway.ensureLocalCredential")(function*(
  store: GatewayStore,
  home: string,
  port: number
): Effect.fn.Return<string, GatewayStoreError> {
  const existing = yield* store.findClientByName(defaultTenantId, localClientName)
  const client = existing ?? (yield* store.createClient({
    id: newClientId(),
    tenantId: defaultTenantId,
    name: localClientName,
    capabilities: ["provision_connections", "administer_gateway"]
  }))
  const key = generateApiKey()
  yield* store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash })
  yield* Effect.promise(() => writeGatewayConfig(home, {
    port,
    url: `http://127.0.0.1:${port}`,
    apiKey: key.secret,
    pid: process.pid
  }))
  return key.secret
})
