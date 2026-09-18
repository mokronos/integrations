import { Context, Effect, Layer } from "effect"
import type { GoogleIdentityOAuth } from "@mokronos/integrations-gateway-core"
import type { GatewayStoreError } from "@mokronos/integrations-gateway-core"
import type { WebAssets } from "../web-assets.ts"

export interface SignInPolicy {
  readonly signupOpen: () => Effect.Effect<boolean, GatewayStoreError>
  readonly secureCookies: boolean
  readonly sessionTtlHours?: number
  readonly google?: GoogleIdentityOAuth
}

export class SessionPolicy extends Context.Service<SessionPolicy, SignInPolicy>()(
  "@mokronos/integrations-gateway-api/SessionPolicy"
) {
  static readonly closed: Layer.Layer<SessionPolicy> = Layer.succeed(SessionPolicy, {
    signupOpen: () => Effect.succeed(false),
    secureCookies: false
  })
}

export interface GatewaySettings {
  readonly retentionDays: number
  readonly dashboardUrl?: () => string | undefined
  readonly oauthCallbackUrl?: () => string | undefined
  readonly mcpUrl?: () => string | undefined
  readonly registryUrl?: string
}

export class GatewayConfig extends Context.Service<GatewayConfig, GatewaySettings>()(
  "@mokronos/integrations-gateway-api/GatewayConfig"
) {}

export class ControlPlaneAssets extends Context.Service<
  ControlPlaneAssets,
  { readonly assets: WebAssets | undefined }
>()("@mokronos/integrations-gateway-api/ControlPlaneAssets") {
  static readonly layerOf = (assets: WebAssets | undefined): Layer.Layer<ControlPlaneAssets> =>
    Layer.succeed(ControlPlaneAssets, { assets })
}
