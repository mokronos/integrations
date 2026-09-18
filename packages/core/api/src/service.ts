import {
  defaultArgumentRetentionDays,
  defaultGatewayPort,
  defaultTenantId,
  gatewayCoreLayer,
  GatewayStoreError,
  GatewayStoreService,
  generateApiKey,
  libsqlLayer,
  newClientId,
  OAuthFlowSessions,
  reconcileConfigurations,
  resolveEncryption,
  writeGatewayConfig
} from "@mokronos/integrations-gateway-core"
import type { Encryption, GatewayCoreServices, GatewayStore } from "@mokronos/integrations-gateway-core"
import type { GoogleIdentityOAuth } from "@mokronos/integrations-gateway-core"
import { whenPresent } from "@mokronos/integrations-contracts"
import { webCryptoLayer } from "@mokronos/integrations-contracts"
import { Integrations } from "@mokronos/integrations-host"
import type { StorageError } from "@mokronos/integrations-host"
import { Context, Crypto, Effect, Layer, ManagedRuntime, Option } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { isLoopbackAddress, mayBorrowLocalCredential } from "./http/loopback.ts"
import { createGatewayHandler } from "./http/handler.ts"
import type { GatewayHandle, GatewayHandlerOptions, GatewayRequestContext } from "./http/handler.ts"
import type { RateLimits } from "./http/authority.ts"
import { authorizeInBrowser } from "./oauth-browser.ts"
import { integrationsHome } from "./paths.ts"
import { createWebAssets } from "./web-assets.ts"
import { defaultRateLimitPerMinute, gatewayEnvironment } from "./config.ts"
import { telemetryLayer } from "@mokronos/integrations-observability"

export const localClientName = "local"

export interface GatewayService {
  readonly home: string
  readonly store: GatewayStore
  readonly handle: (request: Request, context?: GatewayRequestContext) => Promise<Response>
  close(): Promise<void>
}

export interface GatewayServiceOptions {
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>
  /** The database. Defaults to the SQLite file under `home`. */
  readonly sqlClient?: Layer.Layer<SqlClient.SqlClient>
  /** The master key. Defaults to the environment's, then the key file under `home`. */
  readonly encryption?: Encryption
  readonly home?: string
  readonly migrate?: boolean
  readonly maintenance?: boolean
  readonly retentionDays?: number
  readonly registryUrl?: string
  readonly publicUrl?: string
  readonly googleIdentity?: Pick<GoogleIdentityOAuth, "clientId" | "clientSecret">
  readonly localCallbackOrigin?: string
  readonly secureCookies?: boolean
  readonly allowSignup?: boolean
  readonly rateLimitPerMinute?: number
  readonly maxBodyBytes?: number
  readonly telemetryEndpoint?: string
  readonly telemetryHeaders?: Record<string, string>
}

interface GatewayCore {
  readonly home: string
  readonly services: Context.Context<GatewayCoreServices>
  readonly store: GatewayStore
  readonly handlerOptions: GatewayHandlerOptions
  readonly disposeCore: () => Promise<void>
}

const signupOpen = (
  store: GatewayStore,
  explicitlyAllowed: boolean
): Effect.Effect<boolean, GatewayStoreError> =>
  explicitlyAllowed ? Effect.succeed(true) : store.countLogins().pipe(Effect.map((count) => count === 0))

const buildCore = async (options: GatewayServiceOptions): Promise<GatewayCore> => {
  const environment = await Effect.runPromise(gatewayEnvironment)
  const home = options.home ?? integrationsHome()
  const encryption = options.encryption ?? await resolveEncryption({
    ...whenPresent("envValue", Option.getOrUndefined(environment.masterKey)),
    keyFile: `${home}/gateway.key`
  })
  const resolvePublicUrl = (): string | undefined =>
    options.publicUrl ?? Option.getOrUndefined(environment.publicUrl) ?? options.localCallbackOrigin

  const runtime = ManagedRuntime.make(
    gatewayCoreLayer({
      encryption,
      blobDirectory: home,
      publicUrlOf: resolvePublicUrl,
      authorizeLocally: authorizeInBrowser,
      ...whenPresent("migrate", options.migrate),
      ...whenPresent("maintenance", options.maintenance)
    }).pipe(Layer.provide(Layer.merge(
      options.sqlClient ?? libsqlLayer(`${home}/gateway.sqlite`),
      options.httpClient
    )))
  )
  let services: Context.Context<GatewayCoreServices>
  try {
    services = await runtime.runPromise(Effect.context<GatewayCoreServices>())
  } catch (error) {
    await runtime.dispose()
    throw error
  }
  const store = Context.get(services, GatewayStoreService)

  const googleClientId = options.googleIdentity?.clientId ??
    Option.getOrUndefined(environment.googleClientId)
  const googleClientSecret = options.googleIdentity?.clientSecret ??
    Option.getOrUndefined(environment.googleClientSecret)
  const googleIdentity: GoogleIdentityOAuth | undefined =
    googleClientId === undefined || googleClientSecret === undefined
      ? undefined
      : { clientId: googleClientId, clientSecret: googleClientSecret, publicUrlOf: resolvePublicUrl }

  const perMinute = options.rateLimitPerMinute ??
    Option.getOrElse(environment.rateLimitPerMinute, () => defaultRateLimitPerMinute)
  const rateLimits: RateLimits = {
    principalPerMinute: perMinute,
    addressPerMinute: Math.max(20, Math.floor(perMinute / 5))
  }
  const withOrigin = (suffix: string) => (): string | undefined => {
    const origin = resolvePublicUrl()
    return origin === undefined ? undefined : `${origin.replace(/\/+$/, "")}${suffix}`
  }

  return {
    home,
    services,
    store,
    disposeCore: () => runtime.dispose(),
    handlerOptions: {
      store,
      integrationServices: services,
      oauth: Context.get(services, OAuthFlowSessions),
      httpClient: options.httpClient,
      retentionDays: options.retentionDays ?? defaultArgumentRetentionDays,
      oauthCallbackUrl: withOrigin("/v1/oauth/callback"),
      mcpUrl: withOrigin("/mcp"),
      dashboardUrl: resolvePublicUrl,
      rateLimits,
      observabilityLayer: telemetryLayer({
        serviceName: "integrations-gateway",
        ...whenPresent("endpoint", options.telemetryEndpoint),
        ...whenPresent("headers", options.telemetryHeaders)
      }),
      ...whenPresent("maxBodyBytes", options.maxBodyBytes),
      sessions: {
        signupOpen: () => signupOpen(store, options.allowSignup ?? environment.allowSignup),
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

  let closed = false
  return {
    home: core.home,
    store: core.store,
    handle: (request, context) => handle.handle(request, context),
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
        Context.get(core.services, Integrations),
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
  const defaults = yield* reconcileConfigurations({ store, integrations, tenantId: defaultTenantId })
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
