import { createGatewayService, type GatewayService } from "@mokronos/integrations-gateway-api"
import {
  createEncryption,
  deliverDueApprovalNotifications,
  runMaintenance
} from "@mokronos/integrations-gateway-core"
import type { D1Database } from "@cloudflare/workers-types"
import type { AssetsFetcherLike, ExecutionContextLike, ScheduledEventLike } from "./cloudflare.ts"
import { Effect, Layer } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { decodeBase64UrlField } from "@mokronos/integrations-contracts"
import { FetchHttpClient } from "effect/unstable/http"
import { D1Client } from "@effect/sql-d1"

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

export interface Env {
  readonly DB: D1Database
  readonly ASSETS?: AssetsFetcherLike
  readonly INTEGRATIONS_MASTER_KEY?: string
  readonly INTEGRATIONS_PUBLIC_URL?: string
  readonly INTEGRATIONS_GOOGLE_CLIENT_ID?: string
  readonly INTEGRATIONS_GOOGLE_CLIENT_SECRET?: string
  readonly INTEGRATIONS_ALLOW_SIGNUP?: string
}

let servicePromise: Promise<GatewayService> | undefined

const publicUrlOption = (value: string | undefined): { readonly publicUrl?: string } =>
  value === undefined || value.length === 0 ? {} : { publicUrl: value }

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
    return await createGatewayService({
      home: "/integrations-worker",
      httpClient: FetchHttpClient.layer,
      sqlClient: d1Layer(env.DB),
      encryption: createEncryption(masterKeyFromEnv(env.INTEGRATIONS_MASTER_KEY)),
      maintenance: false,
      secureCookies: true,
      allowSignup: env.INTEGRATIONS_ALLOW_SIGNUP === "1",
      ...googleIdentityOption(
        env.INTEGRATIONS_GOOGLE_CLIENT_ID,
        env.INTEGRATIONS_GOOGLE_CLIENT_SECRET
      ),
      ...publicUrlOption(env.INTEGRATIONS_PUBLIC_URL)
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
  async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
    const pathname = new URL(request.url).pathname
    if (!pathname.startsWith("/v1/") && pathname !== "/mcp" && env.ASSETS !== undefined) {
      return await env.ASSETS.fetch(request)
    }
    try {
      const service = await getService(env)
      const remoteAddress = request.headers.get("CF-Connecting-IP")
      const response = await service.handle(
        request,
        remoteAddress === null ? {} : { remoteAddress }
      )
      // The isolate may freeze once the response is out; this is what gets the batch exported.
      context.waitUntil(service.flushTelemetry())
      return response
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
    const sweep = runMaintenance(service.store).pipe(
      Effect.andThen(env.INTEGRATIONS_PUBLIC_URL === undefined
        ? deliverDueApprovalNotifications({ store: service.store })
        : deliverDueApprovalNotifications({
          store: service.store,
          dashboardUrl: env.INTEGRATIONS_PUBLIC_URL
        })),
      Effect.withSpan("Maintenance.scheduled"),
      Effect.provide(Layer.merge(FetchHttpClient.layer, service.telemetry))
    )
    try {
      await Effect.runPromise(sweep)
    } finally {
      await service.flushTelemetry()
    }
  }
}
