import { createGatewayService, type GatewayService } from "@mokronos/gateway-api"
import {
  createEncryption,
  GatewayStoreService,
  deliverDueApprovalNotifications,
  runMaintenance,
  type Encryption
} from "@mokronos/gateway-core"
import type { D1Database } from "@cloudflare/workers-types"
import type { AssetsFetcherLike, D1DatabaseLike, ScheduledEventLike } from "./cloudflare.ts"
import { Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Effect } from "effect"
import { decodeBase64UrlField } from "@mokronos/contracts"
import { FetchHttpClient } from "effect/unstable/http"
import { D1Client } from "@effect/sql-d1"
import { d1HostStorage } from "./host-storage-d1.ts"
import { D1OAuthSessionStore } from "./oauth-store-d1.ts"

export const masterKeyFromEnv = (envValue: string | undefined): Uint8Array => {
  if (envValue === undefined || envValue.length === 0) {
    throw new Error(
      "INTEGRATIONS_MASTER_KEY is not set. A hosted gateway seals payloads at rest; " +
      "provision one with: wrangler secret put INTEGRATIONS_MASTER_KEY " +
      "(base64url of 32 bytes, e.g. openssl rand -base64 32)"
    )
  }
  const key = decodeBase64UrlField("INTEGRATIONS_MASTER_KEY", envValue)
  if (key.length !== 32) {
    throw new Error(
      `INTEGRATIONS_MASTER_KEY must decode to 32 bytes, got ${key.length}`
    )
  }
  return key
}

const resolveMasterKey = async (
  envValue: string | undefined
): Promise<{ readonly key: Uint8Array; readonly encryption: Encryption }> => {
  const key = masterKeyFromEnv(envValue)
  return { key, encryption: createEncryption(key) }
}

export interface Env {
  readonly DB: D1Database & D1DatabaseLike
  readonly ASSETS?: AssetsFetcherLike
  readonly INTEGRATIONS_MASTER_KEY?: string
  readonly INTEGRATIONS_PUBLIC_URL?: string
  readonly INTEGRATIONS_GOOGLE_CLIENT_ID?: string
  readonly INTEGRATIONS_GOOGLE_CLIENT_SECRET?: string
  readonly INTEGRATIONS_ALLOW_SIGNUP?: string
  readonly INTEGRATIONS_OTLP_ENDPOINT?: string
  readonly INTEGRATIONS_OTLP_AUTHORIZATION?: string
}

let servicePromise: Promise<GatewayService> | undefined

const publicUrlOption = (value: string | undefined): { readonly publicUrl?: string } =>
  value === undefined || value.length === 0 ? {} : { publicUrl: value }

const telemetryEndpointOption = (value: string | undefined): { readonly telemetryEndpoint?: string } =>
  value === undefined || value.length === 0 ? {} : { telemetryEndpoint: value }

const telemetryHeadersOption = (
  value: string | undefined
): { readonly telemetryHeaders?: Record<string, string> } =>
  value === undefined || value.length === 0
    ? {}
    : { telemetryHeaders: { authorization: value } }

const googleIdentityOption = (
  clientIdValue: string | undefined,
  clientSecretValue: string | undefined
): {
  readonly googleIdentity?: {
    readonly clientId: string
    readonly clientSecret: string
  }
} => {
  const clientId = clientIdValue?.trim()
  const clientSecret = clientSecretValue?.trim()
  const hasClientId = clientId !== undefined && clientId.length > 0
  const hasClientSecret = clientSecret !== undefined && clientSecret.length > 0
  if (hasClientId !== hasClientSecret) {
    throw new Error(
      "Google sign-in requires both INTEGRATIONS_GOOGLE_CLIENT_ID and INTEGRATIONS_GOOGLE_CLIENT_SECRET"
    )
  }
  return hasClientId && hasClientSecret
    ? { googleIdentity: { clientId, clientSecret } }
    : {}
}

/**
 * The gateway's tables in D1. The binding is supplied by the runtime, so a
 * configuration failure here is not something the gateway can act on.
 */
const d1Layer = (db: D1Database): Layer.Layer<SqlClient.SqlClient> =>
  Layer.orDie(D1Client.layer({ db }))

const getService = (env: Env): Promise<GatewayService> => {
  servicePromise ??= (async () => {
    const { key, encryption } = await resolveMasterKey(env.INTEGRATIONS_MASTER_KEY)
    const database = env.DB
    return await createGatewayService({
      home: "/integrations-worker",
      httpClient: FetchHttpClient.layer,
      storeLayer: GatewayStoreService.layer(
        "d1:integrations-gateway",
        encryption,
        { sqlClient: d1Layer(database) }
      ),
      hostStorage: d1HostStorage(database, key),
      oauthStore: new D1OAuthSessionStore(database),
      externalMaintenance: true,
      secureCookies: true,
      allowSignup: env.INTEGRATIONS_ALLOW_SIGNUP === "1",
      ...googleIdentityOption(
        env.INTEGRATIONS_GOOGLE_CLIENT_ID,
        env.INTEGRATIONS_GOOGLE_CLIENT_SECRET
      ),
      ...publicUrlOption(env.INTEGRATIONS_PUBLIC_URL),
      ...telemetryEndpointOption(env.INTEGRATIONS_OTLP_ENDPOINT),
      ...telemetryHeadersOption(env.INTEGRATIONS_OTLP_AUTHORIZATION)
    })
  })()
  servicePromise.catch(() => {
    servicePromise = undefined
  })
  return servicePromise
}

interface ErrorView {
  readonly name: string
  readonly message: string
  readonly cause?: ErrorView
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value is unknown by language definition; each field below is guarded by the instanceof check
const unwrapError = (error: unknown): ErrorView => {
  if (!(error instanceof Error)) {
    return { name: "NotAnError", message: String(error) }
  }
  const view: ErrorView = { name: error.name, message: error.message }
  return error.cause === undefined ? view : { ...view, cause: unwrapError(error.cause) }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname
    if (!pathname.startsWith("/v1/") && pathname !== "/mcp" && env.ASSETS !== undefined) {
      return await env.ASSETS.fetch(request)
    }
    try {
      const service = await getService(env)
      const remoteAddress = request.headers.get("CF-Connecting-IP")
      return await service.handle(
        request,
        remoteAddress === null ? {} : { remoteAddress }
      )
    } catch (cause) {
      console.error("gateway request failed", request.method, pathname, unwrapError(cause))
      return Response.json(
        { status: "failed", message: cause instanceof Error ? cause.message : "gateway unavailable" },
        { status: 500 }
      )
    }
  },

  async scheduled(_event: ScheduledEventLike, env: Env): Promise<void> {
    const service = await getService(env)
    await Effect.runPromise(runMaintenance(service.store))
    await Effect.runPromise((env.INTEGRATIONS_PUBLIC_URL === undefined
      ? deliverDueApprovalNotifications({ store: service.store })
      : deliverDueApprovalNotifications({
        store: service.store,
        dashboardUrl: env.INTEGRATIONS_PUBLIC_URL
      })).pipe(Effect.provide(FetchHttpClient.layer)))
  }
}
