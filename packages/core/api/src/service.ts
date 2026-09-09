import {
  defaultArgumentRetentionDays,
  defaultGatewayPort,
  writeGatewayConfig
} from "@integrations/gateway-core"
import { whenPresent } from "@integrations/contracts"
import { defaultTenantId } from "@integrations/gateway-core"
import { resolveEncryption } from "@integrations/gateway-core"
import { Context, Crypto, Effect, Layer, ManagedRuntime, Option } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { isLoopbackAddress, mayBorrowLocalCredential } from "./http/loopback.ts"
import { createGatewayHandler } from "./http/handler.ts"
import type { GatewayHandle, GatewayRequestContext } from "./http/handler.ts"
import type { RateLimits } from "./http/authority.ts"
import { startMaintenanceLoop } from "@integrations/gateway-core"
import { deliverDueApprovalNotifications } from "@integrations/gateway-core"
import type { MaintenanceLoop } from "@integrations/gateway-core"
import { createOAuthSessions } from "@integrations/gateway-core"
import {
  reconcileDefaults
} from "@integrations/gateway-core"
import type { OAuthSessionStore } from "@integrations/gateway-core"
import { generateApiKey, newClientId } from "@integrations/gateway-core"
import { integrationsHome } from "./paths.ts"
import type { IntegrationStorage, StorageError } from "@integrations/integrations"
import { createIntegrationRuntime, integrationServicesOf, Integrations } from "@integrations/integrations"
import type { GatewayStoreOptions } from "@integrations/gateway-core"
import type { GatewayStore } from "@integrations/gateway-core"
import { GatewayStoreError, GatewayStoreService } from "@integrations/gateway-core"
import { webCryptoLayer } from "@integrations/contracts"
import { createWebAssets } from "./web-assets.ts"
import { defaultRateLimitPerMinute, gatewayEnvironment } from "./config.ts"
import { telemetryLayer } from "@integrations/observability"
import type { GoogleIdentityOAuth } from "@integrations/gateway-core"

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
  readonly integrationStorage?: IntegrationStorage
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
  explicitlyAllowed: boolean
): Effect.Effect<boolean, GatewayStoreError> =>
  explicitlyAllowed ? Effect.succeed(true) : store.countLogins().pipe(Effect.map((count) => count === 0))

const buildCore = async (
  options: GatewayServiceOptions
): Promise<GatewayCore> => {
  const environment = await Effect.runPromise(gatewayEnvironment)
  const home = options.home ?? integrationsHome()
  const encryption = await resolveEncryption({
    ...whenPresent("envValue", Option.getOrUndefined(environment.masterKey)),
    keyFile: `${home}/gateway.key`
  })
  const storeRuntime = ManagedRuntime.make(
    options.storeLayer ??
    GatewayStoreService.layer(`${home}/gateway.sqlite`, encryption, options.storeOptions)
  )
  const integrationRuntime = createIntegrationRuntime(home, options.httpClient, options.integrationStorage ?? {})
  let resources: Awaited<ReturnType<typeof bootResources>>
  try {
    resources = await bootResources()
    await Effect.runPromise(Effect.gen(function*() {
      const tenants = yield* resources.store.listTenants()
      yield* Effect.forEach(tenants, (tenant) => reconcileDefaults({
        store: resources.store,
        integrations: Context.get(resources.integrationServices, Integrations),
        tenantId: tenant.id
      }), { discard: true })
    }))
  } catch (error) {
    await Promise.all([storeRuntime.dispose(), integrationRuntime.dispose()])
    throw error
  }

  async function bootResources() {
    const [store, integrationServices] = await Promise.all([
      storeRuntime.runPromise(Effect.service(GatewayStoreService)),
      integrationServicesOf(integrationRuntime)
    ])
    return { store, integrationServices }
  }
  const resolvePublicUrl = (): string | undefined =>
    options.publicUrl ?? Option.getOrUndefined(environment.publicUrl) ??
    options.localCallbackOrigin
  const googleClientId = options.googleIdentity?.clientId ??
    Option.getOrUndefined(environment.googleClientId)
  const googleClientSecret = options.googleIdentity?.clientSecret ??
    Option.getOrUndefined(environment.googleClientSecret)
  const googleIdentity: GoogleIdentityOAuth | undefined =
    googleClientId === undefined || googleClientSecret === undefined
      ? undefined
      : {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        publicUrlOf: resolvePublicUrl
      }
  const oauth = createOAuthSessions(resources.integrationServices, {
    publicUrlOf: resolvePublicUrl,
    onConnected: async (session) => {
      const state = session.state
      if (session.bindingTenant === undefined || state.status !== "connected") return
      await Effect.runPromise(reconcileDefaults({
        store: resources.store,
        integrations: Context.get(resources.integrationServices, Integrations),
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

  const perMinute = options.rateLimitPerMinute ??
    Option.getOrElse(environment.rateLimitPerMinute, () => defaultRateLimitPerMinute)
  const rateLimits: RateLimits = {
    principalPerMinute: perMinute,
    addressPerMinute: Math.max(20, Math.floor(perMinute / 5))
  }

  const disposeCore = async () => {
    maintenance?.stop()
    await Effect.runPromise(oauth.stop())
    await Promise.all([storeRuntime.dispose(), integrationRuntime.dispose()])
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
      integrationServices: resources.integrationServices,
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
      rateLimits,
      observabilityLayer: telemetryLayer({
        serviceName: "integrations-gateway",
        ...whenPresent("endpoint", options.telemetryEndpoint),
        ...whenPresent("headers", options.telemetryHeaders)
      }),
      ...whenPresent("maxBodyBytes", options.maxBodyBytes),
      sessions: {
        signupOpen: () => signupOpen(resources.store, options.allowSignup ?? environment.allowSignup),
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
  readonly webDirectory?: string
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
    const web = options.web === false
      ? undefined
      : await Effect.runPromise(createWebAssets({
        ...whenPresent(
          "directories",
          options.webDirectory === undefined ? undefined : [options.webDirectory]
        )
      }))

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
    localSecret = await Effect.runPromise(Effect.provide(
      ensureLocalCredential(
        core.store,
        Context.get(core.handlerOptions.integrationServices, Integrations),
        core.home,
        boundPort
      ),
      webCryptoLayer
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
  integrations: Integrations["Service"],
  home: string,
  port: number
): Effect.fn.Return<string, GatewayStoreError | StorageError, Crypto.Crypto> {
  const existing = yield* store.findClientByName(defaultTenantId, localClientName)
  const defaults = yield* reconcileDefaults({ store, integrations, tenantId: defaultTenantId })
  if (defaults.accessProfile === undefined || defaults.approvalPolicy === undefined) {
    return yield* new GatewayStoreError({
      operation: "ensureLocalCredential",
      kind: "malformed-row",
      cause: new Error("The default tenant has no default access profile or approval policy")
    })
  }
  const client = existing ?? (yield* store.createClient({
    id: (yield* newClientId),
    tenantId: defaultTenantId,
    accessProfileId: defaults.accessProfile.id,
    approvalPolicyId: defaults.approvalPolicy.id,
    name: localClientName,
    capabilities: ["provision_connections", "administer_gateway"]
  }))
  const key = (yield* generateApiKey)
  yield* store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash })
  yield* Effect.promise(() => writeGatewayConfig(home, {
    port,
    url: `http://127.0.0.1:${port}`,
    apiKey: key.secret,
    pid: process.pid
  }))
  return key.secret
})
