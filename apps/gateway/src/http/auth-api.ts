import { Schema } from "effect"
import { generateSessionToken, hashPassword, verifyPassword } from "../passwords.ts"
import { newSubjectId, newTenantId } from "../keys.ts"
import { generateLoginHandoff, hashLoginHandoff } from "../keys.ts"
import type { SessionTokenHash } from "../domain.ts"
import type { GatewayStore } from "../store.ts"
import { badRequest, created, decodeBody, ok } from "./router.ts"
import type { Route } from "./router.ts"
import {
  clearedSessionCookieHeader,
  sessionCookieHeader
} from "./handler.ts"
import {
  googleIdentityAuthorizationUrl,
  googleIdentityCallbackUrl,
  resolveGoogleIdentity
} from "../identity-oauth.ts"
import type { GoogleIdentityOAuth } from "../identity-oauth.ts"
import { oauthBrowserPage } from "../oauth.ts"

const Email = Schema.String.check(
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
)

const SignupBody = Schema.Struct({
  email: Email,
  /** The one strength rule enforced structurally; scrypt compensates for
   *  complexity, never for length. */
  password: Schema.String.check(Schema.isMinLength(8)),
  tenantName: Schema.optional(Schema.String)
})

const LoginBody = Schema.Struct({
  email: Email,
  password: Schema.String
})

const ChangeEmailBody = Schema.Struct({
  email: Email,
  /** Re-authentication on the way in: whoever can type the current password
   *  may redirect the account, and a hijacked tab cannot. */
  password: Schema.String
})

const ChangePasswordBody = Schema.Struct({
  currentPassword: Schema.optional(Schema.String),
  newPassword: Schema.String.check(Schema.isMinLength(8))
})

const DeleteAccountBody = Schema.Struct({
  password: Schema.optional(Schema.String)
})

export interface AuthDependencies {
  readonly store: GatewayStore
  /** Whether POST /v1/auth/signup may create a new tenant. True while the
   *  gateway has no logins at all (so its first human can claim it) and after
   *  that only when an operator opts in. */
  readonly signupOpen: () => Promise<boolean>
  /** Set on session cookies when the gateway is served over TLS. */
  readonly secureCookies: boolean
  readonly sessionTtlHours?: number
  /** Human sign-in through Google. Deliberately separate from integration
   * OAuth, which authorizes tools rather than operators. */
  readonly google?: GoogleIdentityOAuth
}

const defaultSessionTtlHours = 24 * 30

const safeReturnPath = (candidate: string | null): string | null => {
  if (candidate === null || !candidate.startsWith("/")) return null
  const base = "https://gateway.invalid"
  const resolved = new URL(candidate, base)
  return resolved.origin === base
    ? `${resolved.pathname}${resolved.search}${resolved.hash}`
    : null
}

/** The login surface. Public by necessity — these routes are how a credential
 *  comes to exist — and deliberately small.
 *
 * Failures do not distinguish "unknown email" from "wrong password". The
 * difference is an enumeration oracle for anyone harvesting credentials, and
 * the human who needs to know already knows which one it was. */
export const authRoutes = (dependencies: AuthDependencies): ReadonlyArray<Route> => {
  const ttlHours = dependencies.sessionTtlHours ?? defaultSessionTtlHours

  const issueSession = async (
    subjectId: Parameters<GatewayStore["createSession"]>[0]["subjectId"],
    tenantId: Parameters<GatewayStore["createSession"]>[0]["tenantId"]
  ): Promise<{ readonly token: string; readonly cookie: string }> => {
    const token = generateSessionToken()
    await dependencies.store.createSession({
      tokenHash: token.hash,
      subjectId,
      tenantId,
      expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000)
    })
    return {
      token: token.secret,
      cookie: sessionCookieHeader(token.secret, {
        maxAgeSeconds: Math.round(ttlHours * 60 * 60),
        secure: dependencies.secureCookies
      })
    }
  }

  const startSession = async (
    subjectId: Parameters<GatewayStore["createSession"]>[0]["subjectId"],
    tenantId: Parameters<GatewayStore["createSession"]>[0]["tenantId"]
  ): Promise<string> => (await issueSession(subjectId, tenantId)).cookie

  const browserPage = (title: string, message: string, status = 200) => ({
    status,
    body: {},
    html: oauthBrowserPage({ title, message })
  })

  return [
    {
      method: "GET",
      path: "/v1/auth/providers",
      access: "public",
      handle: async () => ok({
        signupOpen: await dependencies.signupOpen(),
        google: dependencies.google === undefined
          ? { enabled: false }
          : {
            enabled: true,
            startUrl: "/v1/auth/google/start",
            callbackUrl: googleIdentityCallbackUrl(dependencies.google)
          }
      })
    },
    {
      method: "POST",
      path: "/v1/auth/cli/start",
      access: "public",
      handle: async () => {
        if (dependencies.google === undefined) {
          return {
            status: 501,
            body: {
              error: "Browser sign-in is not configured on this gateway",
              code: "identity-provider-unavailable"
            }
          }
        }
        const request = generateLoginHandoff()
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
        await dependencies.store.createLoginHandoff({ requestHash: request.hash, expiresAt })
        const start = new URL("/v1/auth/google/start", googleIdentityCallbackUrl(dependencies.google))
        start.searchParams.set("handoff", request.secret)
        return created({
          requestId: request.secret,
          authorizationUrl: start.toString(),
          expiresAt,
          intervalMs: 1_000
        })
      }
    },
    {
      method: "GET",
      path: "/v1/auth/cli/:id",
      access: "public",
      handle: async (request) => {
        const requestHash = hashLoginHandoff(request.params["id"] ?? "")
        const handoff = await dependencies.store.getLoginHandoff(requestHash)
        if (handoff === undefined) {
          return { status: 404, body: { error: "Unknown login handoff", code: "login-handoff-unknown" } }
        }
        if (handoff.expiresAt.getTime() <= Date.now()) {
          return { status: 410, body: { error: "Login handoff expired", code: "login-handoff-expired" } }
        }
        if (handoff.collectedAt !== null) {
          return { status: 410, body: { error: "Login handoff was already collected", code: "login-handoff-collected" } }
        }
        if (handoff.subjectId === null || handoff.tenantId === null || handoff.email === null) {
          return ok({ status: "pending", expiresAt: handoff.expiresAt })
        }
        if (!await dependencies.store.collectLoginHandoff(requestHash)) {
          return { status: 409, body: { error: "Login handoff was collected concurrently", code: "login-handoff-collected" } }
        }
        const session = await issueSession(handoff.subjectId, handoff.tenantId)
        return ok({ status: "authenticated", token: session.token, email: handoff.email })
      }
    },
    {
      method: "GET",
      path: "/v1/auth/google/start",
      access: "public",
      handle: async (request) => {
        if (dependencies.google === undefined) {
          return browserPage("Google sign-in unavailable", "This gateway has not configured Google sign-in.", 501)
        }
        const handoffSecret = request.query.get("handoff")
        const handoffHash = handoffSecret === null ? null : hashLoginHandoff(handoffSecret)
        if (handoffHash !== null) {
          const handoff = await dependencies.store.getLoginHandoff(handoffHash)
          if (handoff === undefined || handoff.expiresAt.getTime() <= Date.now() || handoff.collectedAt !== null) {
            return browserPage("Sign-in link expired", "Return to the terminal and run `ii login` again.", 410)
          }
        }
        const state = generateLoginHandoff()
        const returnPath = safeReturnPath(request.query.get("returnTo"))
        await dependencies.store.createIdentityOAuthState({
          stateHash: state.hash,
          provider: "google",
          handoffHash,
          returnPath,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000)
        })
        return {
          status: 302,
          body: { redirecting: true },
          headers: {
            location: googleIdentityAuthorizationUrl(dependencies.google, state.secret),
            "cache-control": "no-store"
          }
        }
      }
    },
    {
      method: "GET",
      path: "/v1/auth/google/callback",
      access: "public",
      handle: async (request) => {
        if (dependencies.google === undefined) {
          return browserPage("Google sign-in unavailable", "This gateway has not configured Google sign-in.", 501)
        }
        const stateSecret = request.query.get("state")
        const code = request.query.get("code")
        if (stateSecret === null || code === null) {
          return browserPage("Sign-in failed", "Google did not return a complete sign-in response.", 400)
        }
        const state = await dependencies.store.consumeIdentityOAuthState(hashLoginHandoff(stateSecret))
        if (state === undefined) {
          return browserPage("Sign-in expired", "This sign-in could not be verified. Start again.", 400)
        }
        try {
          const identity = await resolveGoogleIdentity(dependencies.google, code)
          const existingIdentity = await dependencies.store.findExternalIdentity(
            "google",
            identity.providerSubject
          )
          let login = existingIdentity === undefined
            ? await dependencies.store.findLoginByEmail(identity.email)
            : await dependencies.store.findLoginBySubject(existingIdentity.subjectId)

          if (login === undefined) {
            if (!(await dependencies.signupOpen())) {
              return browserPage(
                "Account not found",
                "This gateway does not allow new accounts. Ask an operator to invite or create yours.",
                403
              )
            }
            const tenant = await dependencies.store.createTenant({
              id: newTenantId(),
              name: identity.email.split("@")[0] ?? identity.email
            })
            const subject = await dependencies.store.createSubject({
              id: newSubjectId(),
              tenantId: tenant.id
            })
            login = await dependencies.store.createLogin({
              subjectId: subject.id,
              tenantId: tenant.id,
              email: identity.email,
              passwordHash: null
            })
          }

          await dependencies.store.createExternalIdentity({
            provider: "google",
            providerSubject: identity.providerSubject,
            subjectId: login.subjectId,
            tenantId: login.tenantId,
            email: identity.email
          })
          if (state.handoffHash !== null) {
            const completed = await dependencies.store.completeLoginHandoff({
              requestHash: state.handoffHash,
              subjectId: login.subjectId,
              tenantId: login.tenantId,
              email: login.email
            })
            if (!completed) {
              return browserPage(
                "Terminal sign-in expired",
                "Return to the terminal and run `ii login` again.",
                410
              )
            }
          }
          const cookie = await startSession(login.subjectId, login.tenantId)
          if (state.handoffHash !== null) {
            return {
              ...browserPage(
                "Signed in",
                "The terminal is authenticated. You can close this window and return to ii."
              ),
              headers: { "set-cookie": cookie }
            }
          }
          return {
            status: 302,
            body: { authenticated: true },
            headers: {
              location: state.returnPath ?? "/",
              "set-cookie": cookie,
              "cache-control": "no-store"
            }
          }
        } catch {
          return browserPage("Sign-in failed", "Google sign-in could not be verified. Start again.", 400)
        }
      }
    },
    {
      method: "POST",
      path: "/v1/auth/signup",
      access: "public",
      handle: async (request) => {
        if (!(await dependencies.signupOpen())) {
          return {
            status: 403,
            body: { error: "Signup is closed on this gateway", code: "signup-closed" }
          }
        }
        const body = decodeBody(SignupBody, request.body)
        if (await dependencies.store.findLoginByEmail(body.email) !== undefined) {
          // Stated as taken rather than attempted-and-failed: this is a signup
          // form, not a login oracle.
          return badRequest(`An account for ${body.email} already exists`)
        }
        // Open signup mints a fresh partition per account; joining an existing
        // tenant is an operator action, not a self-serve one.
        const tenant = await dependencies.store.createTenant({
          id: newTenantId(),
          name: body.tenantName ?? body.email.split("@")[0] ?? body.email
        })
        const subject = await dependencies.store.createSubject({
          id: newSubjectId(),
          tenantId: tenant.id
        })
        await dependencies.store.createLogin({
          subjectId: subject.id,
          tenantId: tenant.id,
          email: body.email,
          passwordHash: await hashPassword(body.password)
        })
        // Signing up is signing in: the first session starts immediately.
        return {
          ...created({
            tenant: { id: tenant.id, name: tenant.name },
            subjectId: subject.id,
            email: body.email
          }),
          headers: {
            "set-cookie": await startSession(subject.id, tenant.id)
          }
        }
      }
    },
    {
      method: "POST",
      path: "/v1/auth/login",
      access: "public",
      handle: async (request) => {
        const body = decodeBody(LoginBody, request.body)
        const login = await dependencies.store.findLoginByEmail(body.email)
        const accepted = login?.passwordHash !== null && login?.passwordHash !== undefined &&
          await verifyPassword(body.password, login.passwordHash)
        if (login === undefined || !accepted) {
          return {
            status: 401,
            body: { error: "Email or password is not correct", code: "invalid-credentials" }
          }
        }
        return {
          status: 200,
          body: { email: login.email, subjectId: login.subjectId },
          headers: { "set-cookie": await startSession(login.subjectId, login.tenantId) }
        }
      }
    },
    {
      method: "POST",
      path: "/v1/auth/logout",
      access: "public",
      handle: async (request) => {
        // Revoking beats merely forgetting: a stolen cookie stays valid until
        // its row is gone, so logout deletes the session server-side too.
        if (request.identity.kind === "session") {
          await dependencies.store.revokeSession(request.identity.tokenHash)
        }
        return {
          status: 200,
          body: { loggedOut: true },
          headers: {
            "set-cookie": clearedSessionCookieHeader({ secure: dependencies.secureCookies })
          }
        }
      }
    },
    {
      method: "GET",
      path: "/v1/auth/me",
      access: "public",
      handle: async (request) => {
        if (request.identity.kind === "session") {
          const login = await dependencies.store.findLoginBySubject(request.identity.subjectId)
          const identities = await dependencies.store.listExternalIdentities(request.identity.subjectId)
          return ok({
            authenticated: true,
            kind: "session",
            email: request.identity.email,
            tenantId: request.identity.tenantId,
            subjectId: request.identity.subjectId,
            hasPassword: login?.passwordHash !== null && login?.passwordHash !== undefined,
            identityProviders: identities.map((identity) => identity.provider)
          })
        }
        if (request.identity.kind === "client") {
          return ok({
            authenticated: true,
            kind: "client",
            clientId: request.identity.client.id,
            tenantId: request.identity.client.tenantId,
            capabilities: request.identity.client.capabilities
          })
        }
        if (request.identity.kind === "local") {
          return ok({
            authenticated: true,
            kind: "local",
            clientId: request.identity.client.id,
            tenantId: request.identity.client.tenantId
          })
        }
        return ok({ authenticated: false })
      }
    },
    {
      method: "POST",
      path: "/v1/auth/email",
      access: "human",
      handle: async (request) => {
        if (request.identity.kind !== "session") {
          return { status: 403, body: { error: "Only a signed-in human may change account details", code: "not-permitted" } }
        }
        const session = request.identity
        const body = decodeBody(ChangeEmailBody, request.body)
        const login = await dependencies.store.findLoginByEmail(session.email)
        if (login === undefined || login.passwordHash === null ||
          !(await verifyPassword(body.password, login.passwordHash))) {
          return {
            status: 401,
            body: { error: "Email or password is not correct", code: "invalid-credentials" }
          }
        }
        // Same email is a no-op rather than an argument with the schema.
        if (body.email !== login.email &&
          await dependencies.store.findLoginByEmail(body.email) !== undefined
        ) {
          return badRequest(`An account for ${body.email} already exists`)
        }
        await dependencies.store.changeLoginEmail(session.subjectId, body.email)
        // The identity travels in the session row's join; sessions survive an
        // email change, so no re-login is forced.
        return ok({ email: body.email })
      }
    },
    {
      method: "POST",
      path: "/v1/auth/password",
      access: "human",
      handle: async (request) => {
        if (request.identity.kind !== "session") {
          return { status: 403, body: { error: "Only a signed-in human may change account details", code: "not-permitted" } }
        }
        const session = request.identity
        const body = decodeBody(ChangePasswordBody, request.body)
        const login = await dependencies.store.findLoginByEmail(session.email)
        const accepted = login !== undefined && (
          login.passwordHash === null
            ? body.currentPassword === undefined
            : body.currentPassword !== undefined &&
              await verifyPassword(body.currentPassword, login.passwordHash)
        )
        if (login === undefined || !accepted) {
          return {
            status: 401,
            body: { error: "Email or password is not correct", code: "invalid-credentials" }
          }
        }
        await dependencies.store.changeLoginPassword(
          session.subjectId,
          await hashPassword(body.newPassword)
        )
        // A password change is a statement that the old one was compromised-
        // adjacent at best; every other device re-authenticates.
        const revoked = await dependencies.store.revokeSubjectSessions(
          session.subjectId,
          request.identity.kind === "session" ? request.identity.tokenHash : undefined satisfies SessionTokenHash | undefined
        )
        return ok({ updated: true, revokedSessions: revoked })
      }
    },
    {
      // POST rather than DELETE because the confirmation password must ride
      // the body, and the handler treats DELETE bodies as absent.
      method: "POST",
      path: "/v1/auth/account/delete",
      access: "human",
      handle: async (request) => {
        if (request.identity.kind !== "session") {
          return { status: 403, body: { error: "Only a signed-in human may change account details", code: "not-permitted" } }
        }
        const session = request.identity
        const body = decodeBody(DeleteAccountBody, request.body)
        const login = await dependencies.store.findLoginByEmail(session.email)
        if (login?.passwordHash === null) {
          return {
            status: 409,
            body: {
              error: "Set a password before deleting an OAuth-only account",
              code: "password-required"
            }
          }
        }
        const accepted = login !== undefined && body.password !== undefined &&
          await verifyPassword(body.password, login.passwordHash)
        if (login === undefined || !accepted) {
          return {
            status: 401,
            body: { error: "Email or password is not correct", code: "invalid-credentials" }
          }
        }
        // The subject goes first — its cascade takes the login and sessions —
        // and the workspace follows only when nobody is left inside it. A
        // shared tenant survives its member; a solo signup takes its clients,
        // keys, grants, approvals, and audit rows down with it.
        await dependencies.store.deleteSubject(session.subjectId)
        if (await dependencies.store.countSubjects(session.tenantId) === 0) {
          await dependencies.store.deleteTenant(session.tenantId)
        }
        // Vendor connections live in the host's own storage keyed by address,
        // outside this store; they are not reclaimed here.
        return {
          ...ok({ deleted: true }),
          headers: {
            "set-cookie": clearedSessionCookieHeader({ secure: dependencies.secureCookies })
          }
        }
      }
    }
  ]
}
