import { Context, Layer } from "effect"
import type { GoogleIdentityOAuth } from "../identity-oauth.ts"
import type { OAuthSessions } from "../oauth-sessions.ts"
import type { WebAssets } from "../web-assets.ts"

/** What a handler may ask the context for.
 *
 *  These used to be a bag: one `GatewayDependencies` object threaded from the
 *  composition root through every group layer, each factory re-declaring the
 *  slice it needed. The bag made a handler's real requirements invisible — a
 *  group that touched only the store still named the whole world in its
 *  signature — and it meant `service.ts` ran an Effect for the sole purpose of
 *  pulling services back *out* of a context it had just built.
 *
 *  `GatewayStoreService` and `IntegrationsApiService` already existed and are
 *  used as-is; what follows is the rest of what the HTTP layer needs. */

/** Whether a human may sign in here, how, and on what terms. */
export interface SignInPolicy {
  /** Whether POST /v1/auth/signup may create a new tenant. True while the
   *  gateway has no logins at all (so its first human can claim it) and after
   *  that only when an operator opts in. */
  readonly signupOpen: () => Promise<boolean>
  /** Set on session cookies when the gateway is served over TLS. */
  readonly secureCookies: boolean
  readonly sessionTtlHours?: number
  /** Human sign-in through Google. Deliberately separate from integration
   *  OAuth, which authorizes tools rather than operators. */
  readonly google?: GoogleIdentityOAuth
}

export class SessionPolicy extends Context.Service<SessionPolicy, SignInPolicy>()(
  "@mokronos/integrations/SessionPolicy"
) {
  /** The closed default: a gateway with no session configuration still answers
   *  the auth routes, and answers that signup is not available. */
  static readonly closed: Layer.Layer<SessionPolicy> = Layer.succeed(SessionPolicy, {
    signupOpen: async () => false,
    secureCookies: false
  })
}

/** Pending integration OAuth flows. */
export class OAuthFlowSessions extends Context.Service<OAuthFlowSessions, OAuthSessions>()(
  "@mokronos/integrations/OAuthFlowSessions"
) {}

/** Everything else the HTTP layer is configured with. Settings, not
 *  collaborators: nothing here has behaviour beyond answering what it was set
 *  to. The lazily-read URLs are functions because the public origin is only
 *  known once the socket has decided how it is bound. */
export interface GatewaySettings {
  /** How long an audit record keeps its arguments before they are dropped. */
  readonly retentionDays: number
  /** Origin of the authenticated control plane, used only to point a human at
   *  a pending approval. */
  readonly dashboardUrl?: () => string | undefined
  /** Where a provider must redirect after the human approves, so clients can
   *  show it before a flow starts. */
  readonly oauthCallbackUrl?: () => string | undefined
  /** Overrides the public registry for an isolated deployment or acceptance test. */
  readonly registryUrl?: string
}

export class GatewayConfig extends Context.Service<GatewayConfig, GatewaySettings>()(
  "@mokronos/integrations/GatewayConfig"
) {}

/** The control plane's own files, when this deployment serves them. */
export class ControlPlaneAssets extends Context.Service<
  ControlPlaneAssets,
  { readonly assets: WebAssets | undefined }
>()("@mokronos/integrations/ControlPlaneAssets") {
  static readonly layerOf = (assets: WebAssets | undefined): Layer.Layer<ControlPlaneAssets> =>
    Layer.succeed(ControlPlaneAssets, { assets })
}
