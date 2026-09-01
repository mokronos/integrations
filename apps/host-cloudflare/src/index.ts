import { createGatewayService, type GatewayService } from "@mokronos/gateway-api"
import {
  createEncryption,
  GatewayStoreService,
  runMaintenance,
  type Encryption
} from "@mokronos/gateway-core"
import type { AssetsFetcherLike, D1DatabaseLike, ScheduledEventLike } from "./cloudflare.ts"
import { Effect } from "effect"
import { D1Client } from "./d1-client.ts"
import { d1HostStorage } from "./host-storage-d1.ts"
import { D1OAuthSessionStore } from "./oauth-store-d1.ts"

/** Decodes the configured secret into the 32-byte key every sealed value on
 *  this deployment hangs off: gateway payload sealing and host credential
 *  sealing derive separate keys from it by domain separation. */
export const masterKeyFromEnv = (envValue: string | undefined): Buffer => {
  if (envValue === undefined || envValue.length === 0) {
    throw new Error(
      "INTEGRATIONS_MASTER_KEY is not set. A hosted gateway seals payloads at rest; " +
      "provision one with: wrangler secret put INTEGRATIONS_MASTER_KEY " +
      "(base64url of 32 bytes, e.g. openssl rand -base64 32)"
    )
  }
  const key = Buffer.from(envValue, "base64url")
  if (key.length !== 32) {
    throw new Error(
      `INTEGRATIONS_MASTER_KEY must decode to 32 bytes, got ${key.length}`
    )
  }
  return key
}

const resolveMasterKey = async (
  envValue: string | undefined
): Promise<{ readonly key: Buffer; readonly encryption: Encryption }> => {
  const key = masterKeyFromEnv(envValue)
  return { key, encryption: createEncryption(key) }
}

export interface Env {
  readonly DB: D1DatabaseLike
  readonly ASSETS?: AssetsFetcherLike
  /** Base64url of 32 bytes. Required: a public deployment stores vendor
   *  credentials and approval payloads, so plaintext-at-rest is not a mode it
   *  offers. Provision with `wrangler secret put INTEGRATIONS_MASTER_KEY`. */
  readonly INTEGRATIONS_MASTER_KEY?: string
  /** The origin callers reach, e.g. https://integrations-gateway.example.workers.dev.
   *  Drives OAuth callback URLs; set it before running authorization flows. */
  readonly INTEGRATIONS_PUBLIC_URL?: string
  /** OAuth credentials for human Google sign-in. The secret should be set
   * with `wrangler secret put INTEGRATIONS_GOOGLE_CLIENT_SECRET`. */
  readonly INTEGRATIONS_GOOGLE_CLIENT_ID?: string
  readonly INTEGRATIONS_GOOGLE_CLIENT_SECRET?: string
  /** `1` keeps self-service account creation open after the first claim. */
  readonly INTEGRATIONS_ALLOW_SIGNUP?: string
  /** OTLP/HTTP base URL traces export to (e.g. a hosted collector). Unset
   *  keeps the worker untraced — nothing is built, nothing is exported. */
  readonly INTEGRATIONS_OTLP_ENDPOINT?: string
  /** Raw `authorization` header value on every export, e.g.
   *  Grafana Cloud's `Basic <base64(instance-id:token)>`. */
  readonly INTEGRATIONS_OTLP_AUTHORIZATION?: string
}

/** One service per isolate. Workers keep module state across requests, so the
 *  first request after an eviction pays schema setup and every later request
 *  reuses the composed runtime. */
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

const getService = (env: Env): Promise<GatewayService> => {
  servicePromise ??= (async () => {
    const { key, encryption } = await resolveMasterKey(env.INTEGRATIONS_MASTER_KEY)
    const database = env.DB
    return await createGatewayService({
      // Storage lives in D1; nothing reads this directory. The value only has
      // to exist because the composition root's shape predates hosted storage.
      home: "/integrations-worker",
      storeLayer: GatewayStoreService.layer(
        "d1:integrations-gateway",
        encryption,
        { client: new D1Client(database) }
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
  // An isolate whose bootstrap failed once should not serve half a gateway;
  // forget the failed attempt so the next request retries cleanly.
  servicePromise.catch(() => {
    servicePromise = undefined
  })
  return servicePromise
}

/** How a caught value looks after flattening: one link per nested cause. */
interface ErrorView {
  readonly name: string
  readonly message: string
  readonly cause?: ErrorView
}

/** Errors hide their payload behind non-enumerable fields; flatten the chain
 *  so the platform log shows what actually broke. */
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
    // Static assets normally answer everything outside /v1 (the platform
    // routes them ahead of this Worker); honour the binding directly too, so
    // the Worker also stands alone without the assets configuration.
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
      // Observability logs are how a hosted deployment sees its own failures;
      // an empty 500 body helps nobody.
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
  }
}
