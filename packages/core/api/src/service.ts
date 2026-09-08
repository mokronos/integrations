import {
  defaultArgumentRetentionDays,
  defaultGatewayPort,
  writeGatewayConfig
} from "@mokronos/gateway-core"
import { PositiveInt, PositiveIntFromString, whenPresent } from "@mokronos/contracts"
import { defaultTenantId } from "@mokronos/gateway-core"
import { resolveEncryption } from "@mokronos/gateway-core"
import { Context, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { isLoopbackAddress, mayBorrowLocalCredential } from "./http/loopback.ts"
import { createGatewayHandler } from "./http/handler.ts"
import type { GatewayHandle, GatewayRequestContext } from "./http/handler.ts"
import { startMaintenanceLoop } from "@mokronos/gateway-core"
import { deliverDueApprovalNotifications } from "@mokronos/gateway-core"
import type { MaintenanceLoop } from "@mokronos/gateway-core"
import { createOAuthSessions } from "@mokronos/gateway-core"
import {
  reconcileDefaults
} from "@mokronos/gateway-core"
import type { OAuthSessionStore } from "@mokronos/gateway-core"
import { createRateLimiter } from "@mokronos/gateway-core"
import { generateApiKey, newClientId } from "@mokronos/gateway-core"
import { integrationsHome } from "./paths.ts"
import type { HostStorage, StorageError } from "@mokronos/integrations"
import { createHostRuntime, hostServicesOf, IntegrationHost } from "@mokronos/integrations"
import type { GatewayStoreOptions } from "@mokronos/gateway-core"
import type { GatewayStore } from "@mokronos/gateway-core"
import { GatewayStoreError, GatewayStoreService } from "@mokronos/gateway-core"
import { createWebAssets } from "./web-assets.ts"
import { telemetryLayer } from "@mokronos/observability"
import type { GoogleIdentityOAuth } from "@mokronos/gateway-core"

export const localClientName = "local"

export interface GatewayService {
  readonly home: string
  readonly store: GatewayStore
  readonly handle: (request: Request, context?: GatewayRequestContext) => Promise<Response>
  close(): Promise<void>
}

export interface GatewayServiceOptions {
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>
  readonly home?: string
  readonly retentionDays?: number
  readonly registryUrl?: string
  readonly publicUrl?: string
  readonly googleIdentity?: Pick<GoogleIdentityOAuth, "clientId" | "clientSecret">
  readonly localCallbackOrigin?: string
  readonly secureCookies?: boolean
  readonly allowSignup?: boolean
  readonly rateLimitPerMinute?: number
  readonly maxBodyBytes?: number
  readonly storeLayer?: Layer.Layer<GatewayStoreService, GatewayStoreError>
  readonly hostStorage?: HostStorage
  readonly oauthStore?: OAuthSessionStore
  readonly storeOptions?: GatewayStoreOptions
  readonly externalMaintenance?: boolean
  readonly telemetryEndpoint?: string
  readonly telemetryHeaders?: Record<string, string>
}

interface GatewayCore {
  readonly home: string
  readonly store: GatewayStore
  readonly oauth: ReturnType<typeof createOAuthSessions>
  readonly maintenance: MaintenanceLoop | undefined
  readonly handlerOptions: Parameters<typeof createGatewayHandler>[0]
  readonly disposeCore: () => Promise<void>
}

const signupOpen = (
  store: GatewayStore,
  explicitlyAllowed = process.env["INTEGRATIONS_ALLOW_SIGNUP"] === "1"
): Effect.Effect<boolean, GatewayStoreError> =>
  explicitlyAllowed ? Effect.succeed(true) : store.countLogins().pipe(Effect.map((count) => count === 0))

const nonBlank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

export const defaultRateLimitPerMinute = 600

const buildCore = async (
  options: GatewayServiceOptions
): Promise<GatewayCore> => {
  const home = options.home ?? integrationsHome()
  const encryption = await resolveEncryption({
    ...whenPresent("envValue", process.env["INTEGRATIONS_MASTER_KEY"]),
    keyFile: `${home}/gateway.key`
  })
  const storeRuntime = ManagedRuntime.make(
    options.storeLayer ??
    GatewayStoreService.layer(`${home}/gateway.sqlite`, encryption, options.storeOptions)
  )
  const hostRuntime = createHostRuntime(home, options.httpClient, options.hostStorage ?? {})
  let resources: Awaited<ReturnType<typeof bootResources>>
  try {
    resources = await bootResources()
    await Effect.runPromise(Effect.gen(function*() {
      const tenants = yield* resources.store.listTenants()
      yield* Effect.forEach(tenants, (tenant) => reconcileDefaults({
        store: resources.store,
        integrations: { host: Context.get(resources.hostServices, IntegrationHost) },
        tenantId: tenant.id
      }), { discard: true })
    }))
  } catch (error) {
    await Promise.all([storeRuntime.dispose(), hostRuntime.dispose()])
    throw error
  }

  async function bootResources() {
    const [store, hostServices] = await Promise.all([
      storeRuntime.runPromise(Effect.service(GatewayStoreService)),
      hostServicesOf(hostRuntime)
    ])
    return { store, hostServices }
  }
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
    await Promise.all([storeRuntime.dispose(), hostRuntime.dispose()])
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
        publicUrlOf: resolvePublicUrl
      }
  const oauth = createOAuthSessions(resources.hostServices, {
    publicUrlOf: resolvePublicUrl,
    onConnected: async (session) => {
      const state = session.state
      if (session.bindingTenant === undefined || state.status !== "connected") return
      await Effect.runPromise(reconcileDefaults({
        store: resources.store,
        integrations: { host: Context.get(resources.hostServices, IntegrationHost) },
        tenantId: session.bindingTenant
      }))
    },
    ...whenPresent("store", options.oauthStore)
  })
  const maintenance: MaintenanceLoop | undefined =
    options.externalMaintenance === true ? undefined : startMaintenanceLoop(resources.store, {
      afterSweep: () => deliverDueApprovalNotifications({
        store: resources.store,
        ...whenPresent("dashboardUrl", resolvePublicUrl())
      }).pipe(Effect.provide(options.httpClient))
    })

  const perMinute = Option.getOrElse(
    Schema.decodeUnknownOption(Schema.Union([PositiveInt, PositiveIntFromString]))(
      options.rateLimitPerMinute ?? process.env["INTEGRATIONS_RATE_LIMIT"]
    ),
    () => defaultRateLimitPerMinute
  )
  const rateLimiter = createRateLimiter({
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
    await Promise.all([storeRuntime.dispose(), hostRuntime.dispose()])
  }

  void defaultTenantId

  return {
    home,
    store: resources.store,
    oauth,
    maintenance,
    disposeCore,
    handlerOptions: {
      store: resources.store,
      hostServices: resources.hostServices,
      httpClient: options.httpClient,
      retentionDays: options.retentionDays ?? defaultArgumentRetentionDays,
      oauth,
      oauthCallbackUrl: () => {
        const origin = resolvePublicUrl()
        return origin === undefined
          ? undefined
          : `${origin.replace(/\/+$/, "")}/v1/oauth/callback`
      },
      mcpUrl: () => {
        const origin = resolvePublicUrl()
        return origin === undefined ? undefined : `${origin.replace(/\/+$/, "")}/mcp`
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
  options: GatewayServiceOptions
): Promise<GatewayService> => {
  const core = await buildCore(options)

  const handle = createGatewayHandler(core.handlerOptions)
  const dispatch = async (request: Request, context?: GatewayRequestContext): Promise<Response> => {
    const response = await handle.handle(request, context)
    return response
  }

  let closed = false
  return {
    home: core.home,
    store: core.store,
    handle: dispatch,
    close: async () => {
      if (closed) return
      closed = true
      await handle.dispose()
      await core.disposeCore()
    }
  }
}

export interface ServeOptions {
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>
  readonly port?: number
  readonly hostname?: string
  readonly home?: string
  readonly registryUrl?: string
  readonly publicUrl?: string
  readonly web?: boolean
}

export interface RunningGateway {
  readonly port: number
  readonly url: string
  readonly service: GatewayService
  readonly web: string | undefined
  stop(): Promise<void>
}

export const serveGateway = async (options: ServeOptions): Promise<RunningGateway> => {
  const hostname = options.hostname ?? "127.0.0.1"
  const boundToLoopback = isLoopbackAddress(hostname)
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
        if (web !== undefined && !pathname.startsWith("/v1/") && pathname !== "/mcp") {
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
    localSecret = await Effect.runPromise(ensureLocalCredential(
      core.store,
      Context.get(core.handlerOptions.hostServices, IntegrationHost),
      core.home,
      boundPort
    ))

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

export const ensureLocalCredential = Effect.fn("Gateway.ensureLocalCredential")(function*(
  store: GatewayStore,
  host: IntegrationHost["Service"],
  home: string,
  port: number
): Effect.fn.Return<string, GatewayStoreError | StorageError> {
  const existing = yield* store.findClientByName(defaultTenantId, localClientName)
  const defaults = yield* reconcileDefaults({ store, integrations: { host }, tenantId: defaultTenantId })
  if (defaults.accessProfile === undefined || defaults.approvalPolicy === undefined) {
    return yield* new GatewayStoreError({
      operation: "ensureLocalCredential",
      kind: "malformed-row",
      cause: new Error("The default tenant has no default access profile or approval policy")
    })
  }
  const client = existing ?? (yield* store.createClient({
    id: newClientId(),
    tenantId: defaultTenantId,
    accessProfileId: defaults.accessProfile.id,
    approvalPolicyId: defaults.approvalPolicy.id,
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
