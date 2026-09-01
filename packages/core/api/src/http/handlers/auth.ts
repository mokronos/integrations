import { Clock, Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  LoginHandoffHash,
  SubjectId,
  TenantId
} from "@mokronos/gateway-core"
import type { GoogleIdentityOAuth } from "@mokronos/gateway-core"
import {
  googleIdentityAuthorizationUrl,
  googleIdentityCallbackUrl,
  resolveGoogleIdentity
} from "@mokronos/gateway-core"
import {
  generateLoginHandoff,
  hashLoginHandoff,
  newSubjectId,
  newTenantId
} from "@mokronos/gateway-core"
import { oauthBrowserPage } from "@mokronos/gateway-core"
import { generateSessionToken, hashPassword, verifyPassword } from "@mokronos/gateway-core"
import type { GatewayStore, LoginRecord } from "@mokronos/gateway-core"
import { GatewayStoreError, GatewayStoreService } from "@mokronos/gateway-core"
import {
  ApiBadRequest,
  ApiNotImplemented,
  GatewayApi,
  HandoffCollected,
  HandoffExpired,
  HandoffUnknown,
  InvalidCredentials,
  PasswordRequired,
  SignupClosed
} from "../api.ts"
import {
  clearSessionCookie,
  Forbidden,
  Identity,
  setSessionCookie
} from "../authority.ts"
import type { SignInPolicy } from "../services.ts"
import {
  SessionPolicy
} from "../services.ts"

const orDieStorage = <A, E, R>(effect: Effect.Effect<A, E | GatewayStoreError, R>) =>
  effect.pipe(Effect.catchTag("GatewayStoreError", Effect.die))

/** An HTML page for the OAuth browser flow — one of the few responses here
 *  that really is low-level HTTP rather than a typed endpoint's success value.
 *  It no longer carries headers: a cookie set alongside a page goes through
 *  {@link setSessionCookie} like every other cookie does. */
const page = (
  status: number,
  content: { readonly title: string; readonly message: string }
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(oauthBrowserPage(content), {
    status,
    contentType: "text/html; charset=utf-8"
  })

/** The login surface's failures do not distinguish "unknown email" from "wrong
 *  password". The difference is an enumeration oracle for anyone harvesting
 *  credentials, and the human who needs to know already knows which one it
 *  was. */
const verifyLoginPassword = Effect.fn("Auth.verifyLoginPassword")(function*(
  store: GatewayStore,
  email: string,
  password: string
): Effect.fn.Return<
  | { readonly accepted: false }
  | {
    readonly accepted: true
    readonly login: LoginRecord
  },
  GatewayStoreError
> {
  const login = yield* store.findLoginByEmail(email)
  const passwordHash = login?.passwordHash
  const accepted = passwordHash !== null && passwordHash !== undefined &&
    (yield* verifyPassword(password, passwordHash).pipe(Effect.orDie))
  return !accepted || login === undefined
    ? { accepted: false }
    : { accepted: true, login }
})

const safeReturnPath = (candidate: string | undefined): string | null => {
  if (candidate === undefined || !candidate.startsWith("/")) return null
  const base = "https://gateway.invalid"
  const resolved = new URL(candidate, base)
  return resolved.origin === base
    ? `${resolved.pathname}${resolved.search}${resolved.hash}`
    : null
}

// --- system -----------------------------------------------------------------

export const AuthLayer = HttpApiBuilder.group(GatewayApi, "auth", (handlers) =>
  Effect.gen(function*() {
    const store = yield* GatewayStoreService
    const sessions = yield* SessionPolicy
    const ttlHours = sessions.sessionTtlHours ?? defaultSessionTtlHours
    const secureCookies = sessions.secureCookies

    const issueSession = (subjectId: SubjectId, tenantId: TenantId) =>
      Effect.gen(function*() {
        const token = generateSessionToken()
        const expiresAt = new Date((yield* Clock.currentTimeMillis) + ttlHours * 60 * 60 * 1000)
        yield* orDieStorage(store.createSession({ tokenHash: token.hash, subjectId, tenantId, expiresAt }))
        return { token: token.secret }
      })

    /** The cookie every sign-in path ends with, whatever shape its response takes. */
    const startSession = (token: string) =>
      setSessionCookie(token, {
        maxAgeSeconds: Math.round(ttlHours * 60 * 60),
        secure: secureCookies
      })

    return handlers
      .handle("providers", () =>
        Effect.gen(function*() {
          const signupOpen = yield* orDieStorage(sessions.signupOpen())
          const google = sessions.google
          return {
            signupOpen,
            google: google === undefined
              ? ({ enabled: false } as const)
              : ({
                enabled: true,
                startUrl: "/v1/auth/google/start",
                callbackUrl: googleIdentityCallbackUrl(google)
              } as const)
          }
        }))
      .handle("cliStart", () =>
        Effect.gen(function*() {
          const google = sessions.google
          if (google === undefined) {
            return yield* new ApiNotImplemented({
              error: "Browser sign-in is not configured on this gateway",
              code: "identity-provider-unavailable" as const
            })
          }
          const request = generateLoginHandoff()
          const expiresAt = new Date((yield* Clock.currentTimeMillis) + handoffTtlMs)
          yield* orDieStorage(store.createLoginHandoff({ requestHash: request.hash, expiresAt }))
          const start = new URL("/v1/auth/google/start", googleIdentityCallbackUrl(google))
          start.searchParams.set("handoff", request.secret)
          return {
            requestId: request.secret,
            authorizationUrl: start.toString(),
            expiresAt,
            intervalMs: 1_000
          }
        }))
      .handle("cliPoll", (request) =>
        Effect.gen(function*() {
          const requestHash = hashLoginHandoff(request.params["id"])
          const handoff = yield* orDieStorage(store.getLoginHandoff(requestHash))
          if (handoff === undefined) {
            return yield* new HandoffUnknown({
              error: "Unknown login handoff",
              code: "login-handoff-unknown" as const
            })
          }
          if (handoff.expiresAt.getTime() <= (yield* Clock.currentTimeMillis)) {
            return yield* new HandoffExpired({
              error: "Login handoff expired",
              code: "login-handoff-expired" as const
            })
          }
          if (handoff.collectedAt !== null) {
            return yield* new HandoffCollected({
              error: "Login handoff was already collected",
              code: "login-handoff-collected" as const
            })
          }
          const subjectId = handoff.subjectId
          const tenantId = handoff.tenantId
          const email = handoff.email
          if (subjectId === null || tenantId === null || email === null) {
            return { status: "pending" as const, expiresAt: handoff.expiresAt }
          }
          if (!(yield* orDieStorage(store.collectLoginHandoff(requestHash)))) {
            return yield* new HandoffCollected({
              error: "Login handoff was collected concurrently",
              code: "login-handoff-collected" as const
            })
          }
          const session = yield* issueSession(subjectId, tenantId)
          return {
            status: "authenticated" as const,
            token: session.token,
            email
          }
        }))
      .handle("googleStart", (request) =>
        Effect.gen(function*() {
          const google = sessions.google
          if (google === undefined) {
            return page(501, {
              title: "Google sign-in unavailable",
              message: "This gateway has not configured Google sign-in."
            })
          }
          const handoffSecret = request.query["handoff"]
          const handoffHash = handoffSecret === undefined ? null : hashLoginHandoff(handoffSecret)
          if (handoffHash !== null) {
            const handoff = yield* orDieStorage(store.getLoginHandoff(handoffHash))
            const now = yield* Clock.currentTimeMillis
            if (handoff === undefined || handoff.expiresAt.getTime() <= now ||
              handoff.collectedAt !== null) {
              return page(410, {
                title: "Sign-in link expired",
                message: "Return to the terminal and run `ii login` again."
              })
            }
          }
          const state = generateLoginHandoff()
          const returnPath = safeReturnPath(request.query["returnTo"])
          const stateExpiresAtMs = (yield* Clock.currentTimeMillis) + handoffTtlMs
          yield* orDieStorage(store.createIdentityOAuthState({
            stateHash: state.hash,
            provider: "google",
            handoffHash,
            returnPath,
            expiresAt: new Date(stateExpiresAtMs)
          }))
          return HttpServerResponse.redirect(
            googleIdentityAuthorizationUrl(google, state.secret),
            { status: 302, headers: { "cache-control": "no-store" } }
          )
        }))
      .handle("googleCallback", (request) =>
        Effect.gen(function*() {
          const google = sessions.google
          if (google === undefined) {
            return page(501, {
              title: "Google sign-in unavailable",
              message: "This gateway has not configured Google sign-in."
            })
          }
          const stateSecret = request.query["state"]
          const code = request.query["code"]
          if (stateSecret === undefined || code === undefined) {
            return page(400, {
              title: "Sign-in failed",
              message: "Google did not return a complete sign-in response."
            })
          }
          const state = yield* orDieStorage(store.consumeIdentityOAuthState(hashLoginHandoff(stateSecret)))
          if (state === undefined) {
            return page(400, {
              title: "Sign-in expired",
              message: "This sign-in could not be verified. Start again."
            })
          }
          const outcome = yield* completeGoogleSignIn(
            { store, sessions },
            google,
            code,
            state,
            issueSession
          )
          if (outcome._tag === "page") {
            return page(outcome.status, { title: outcome.title, message: outcome.message })
          }
          yield* startSession(outcome.token)
          if (outcome.handoffHash !== null) {
            return page(200, {
              title: "Signed in",
              message: "The terminal is authenticated. You can close this window and return to ii."
            })
          }
          return HttpServerResponse.redirect(outcome.returnPath ?? "/", {
            status: 302,
            headers: { "cache-control": "no-store" }
          })
        }))
      .handle("signup", (request) =>
        Effect.gen(function*() {
          if (!(yield* orDieStorage(sessions.signupOpen()))) {
            return yield* new SignupClosed({
              error: "Signup is closed on this gateway",
              code: "signup-closed" as const
            })
          }
          const body = request.payload
          if ((yield* orDieStorage(store.findLoginByEmail(body.email))) !== undefined) {
            // Stated as taken rather than attempted-and-failed: this is a
            // signup form, not a login oracle.
            return yield* new ApiBadRequest({ error: `An account for ${body.email} already exists` })
          }
          // Open signup mints a fresh partition per account; joining an
          // existing tenant is an operator action, not a self-serve one.
          const tenant = yield* orDieStorage(store.createTenant({
            id: newTenantId(),
            name: body.tenantName ?? body.email.split("@")[0] ?? body.email
          }))
          const subject = yield* orDieStorage(store.createSubject({ id: newSubjectId(), tenantId: tenant.id }))
          const passwordHash = yield* hashPassword(body.password).pipe(Effect.orDie)
          yield* orDieStorage(store.createLogin({
            subjectId: subject.id,
            tenantId: tenant.id,
            email: body.email,
            passwordHash
          }))
          // Signing up is signing in: the first session starts immediately.
          const session = yield* issueSession(subject.id, tenant.id)
          yield* startSession(session.token)
          return {
            tenant: { id: tenant.id, name: tenant.name },
            subjectId: subject.id,
            email: body.email
          }
        }))
      .handle("login", (request) =>
        Effect.gen(function*() {
          const checked = yield* orDieStorage(
            verifyLoginPassword(store, request.payload.email, request.payload.password))
          if (!checked.accepted) {
            return yield* new InvalidCredentials({
              error: "Email or password is not correct",
              code: "invalid-credentials" as const
            })
          }
          const session = yield* issueSession(checked.login.subjectId, checked.login.tenantId)
          yield* startSession(session.token)
          return {
            email: checked.login.email,
            subjectId: checked.login.subjectId
          }
        }))
      .handle("logout", () =>
        Effect.gen(function*() {
          const caller = yield* Identity
          // Revoking beats merely forgetting: a stolen cookie stays valid until
          // its row is gone, so logout deletes the session server-side too.
          if (caller.kind === "session") {
            yield* orDieStorage(store.revokeSession(caller.tokenHash))
          }
          yield* clearSessionCookie({ secure: secureCookies })
          return { loggedOut: true }
        }))
      .handle("whoami", () =>
        Effect.gen(function*() {
          const caller = yield* Identity
          if (caller.kind === "session") {
            const login = yield* orDieStorage(store.findLoginBySubject(caller.subjectId))
            const identities = yield* orDieStorage(store.listExternalIdentities(caller.subjectId))
            return {
              authenticated: true as const,
              kind: "session" as const,
              email: caller.email,
              tenantId: caller.tenantId,
              subjectId: caller.subjectId,
              hasPassword: login?.passwordHash !== null && login?.passwordHash !== undefined,
              identityProviders: identities.map((identity) => identity.provider)
            }
          }
          if (caller.kind === "client") {
            return {
              authenticated: true as const,
              kind: "client" as const,
              clientId: caller.client.id,
              tenantId: caller.client.tenantId,
              capabilities: caller.client.capabilities
            }
          }
          if (caller.kind === "local") {
            return {
              authenticated: true as const,
              kind: "local" as const,
              clientId: caller.client.id,
              tenantId: caller.client.tenantId
            }
          }
          return { authenticated: false as const }
        }))
      .handle("changeEmail", (request) =>
        Effect.gen(function*() {
          const caller = yield* Identity
          if (caller.kind !== "session") {
            return yield* new Forbidden({
              code: "not-permitted",
              error: "Only a signed-in human may change account details"
            })
          }
          const body = request.payload
          const login = yield* orDieStorage(store.findLoginByEmail(caller.email))
          const passwordHash = login === undefined ? null : login.passwordHash
          const verified = login !== undefined && passwordHash !== null &&
            (yield* verifyPassword(body.password, passwordHash).pipe(Effect.orDie))
          if (!verified || login === undefined) {
            return yield* new InvalidCredentials({
              error: "Email or password is not correct",
              code: "invalid-credentials" as const
            })
          }
          // Same email is a no-op rather than an argument with the schema.
          if (body.email !== login.email &&
            (yield* orDieStorage(store.findLoginByEmail(body.email))) !== undefined) {
            return yield* new ApiBadRequest({ error: `An account for ${body.email} already exists` })
          }
          yield* orDieStorage(store.changeLoginEmail(caller.subjectId, body.email))
          // The identity travels in the session row's join; sessions survive an
          // email change, so no re-login is forced.
          return { email: body.email }
        }))
      .handle("changePassword", (request) =>
        Effect.gen(function*() {
          const caller = yield* Identity
          if (caller.kind !== "session") {
            return yield* new Forbidden({
              code: "not-permitted",
              error: "Only a signed-in human may change account details"
            })
          }
          const body = request.payload
          const login = yield* orDieStorage(store.findLoginByEmail(caller.email))
          const currentPassword = body.currentPassword
          const passwordHash = login === undefined ? null : login.passwordHash
          const accepted = login !== undefined && (
            passwordHash === null
              ? currentPassword === undefined
              : currentPassword !== undefined &&
              (yield* verifyPassword(currentPassword, passwordHash).pipe(Effect.orDie))
          )
          if (!accepted || login === undefined) {
            return yield* new InvalidCredentials({
              error: "Email or password is not correct",
              code: "invalid-credentials" as const
            })
          }
          const newPasswordHash = yield* hashPassword(body.newPassword).pipe(Effect.orDie)
          yield* orDieStorage(store.changeLoginPassword(caller.subjectId, newPasswordHash))
          // A password change is a statement that the old one was compromised-
          // adjacent at best; every other device re-authenticates.
          const revoked = yield* orDieStorage(store.revokeSubjectSessions(caller.subjectId, caller.tokenHash))
          return { updated: true as const, revokedSessions: revoked }
        }))
      .handle("deleteAccount", (request) =>
        Effect.gen(function*() {
          const caller = yield* Identity
          if (caller.kind !== "session") {
            return yield* new Forbidden({
              code: "not-permitted",
              error: "Only a signed-in human may change account details"
            })
          }
          const body = request.payload
          const login = yield* orDieStorage(store.findLoginByEmail(caller.email))
          const passwordHash = login?.passwordHash ?? null
          if (login !== undefined && passwordHash === null) {
            return yield* new PasswordRequired({
              error: "Set a password before deleting an OAuth-only account",
              code: "password-required" as const
            })
          }
          const presented = body.password
          const accepted = login !== undefined && passwordHash !== null &&
            presented !== undefined &&
            (yield* verifyPassword(presented, passwordHash).pipe(Effect.orDie))
          if (!accepted) {
            return yield* new InvalidCredentials({
              error: "Email or password is not correct",
              code: "invalid-credentials" as const
            })
          }
          // The subject goes first — its cascade takes the login and sessions —
          // and the workspace follows only when nobody is left inside it. A
          // shared tenant survives its member; a solo signup takes its clients,
          // keys, configuration assignments, approvals, and audit rows down with it.
          yield* orDieStorage(store.deleteSubject(caller.subjectId))
          if ((yield* orDieStorage(store.countSubjects(caller.tenantId))) === 0) {
            yield* orDieStorage(store.deleteTenant(caller.tenantId))
          }
          // Vendor connections live in the host's own storage keyed by address,
          // outside this store; they are not reclaimed here.
          yield* clearSessionCookie({ secure: secureCookies })
          return { deleted: true }
        }))
  }))

const defaultSessionTtlHours = 24 * 30

/** How long a browser sign-in link and its OAuth state stay usable. Short on
 *  purpose: the human is standing there. */
const handoffTtlMs = 10 * 60 * 1000

type GoogleCallbackOutcome = {
  readonly _tag: "page"
  readonly status: number
  readonly title: string
  readonly message: string
} | {
  readonly _tag: "signedIn"
  readonly handoffHash: string | null
  readonly returnPath: string | null
  readonly token: string
}

const completeGoogleSignIn = (
  dependencies: {
    readonly store: GatewayStore
    readonly sessions: SignInPolicy
  },
  google: GoogleIdentityOAuth,
  code: string,
  state: { readonly handoffHash: string | null; readonly returnPath: string | null },
  issueSession: (
    subjectId: SubjectId,
    tenantId: TenantId
  ) => Effect.Effect<{ readonly token: string }>
): Effect.Effect<GoogleCallbackOutcome> =>
  Effect.gen(function*() {
    const store = dependencies.store
    // Google is the far end here. It being unreachable is not this gateway
    // breaking, and the human staring at the browser deserves to be told which.
    const identity = yield* Effect.result(
      Effect.tryPromise(() => resolveGoogleIdentity(google, code))
    )
    if (identity._tag === "Failure") {
      return {
        _tag: "page",
        status: 502,
        title: "Sign-in failed",
        message: "Google could not be reached to confirm this sign-in. Try again."
      } as const
    }
    const existingIdentity = yield* orDieStorage(store.findExternalIdentity("google", identity.success.providerSubject))
    let login = yield* orDieStorage(
      existingIdentity === undefined
        ? store.findLoginByEmail(identity.success.email)
        : store.findLoginBySubject(existingIdentity.subjectId))

    if (login === undefined) {
      if (!(yield* orDieStorage(dependencies.sessions.signupOpen()))) {
        return {
          _tag: "page",
          status: 403,
          title: "Account not found",
          message: "This gateway does not allow new accounts. Ask an operator to invite or create yours."
        } as const
      }
      const tenant = yield* orDieStorage(store.createTenant({
        id: newTenantId(),
        name: identity.success.email.split("@")[0] ?? identity.success.email
      }))
      const subject = yield* orDieStorage(store.createSubject({ id: newSubjectId(), tenantId: tenant.id }))
      login = yield* orDieStorage(store.createLogin({
        subjectId: subject.id,
        tenantId: tenant.id,
        email: identity.success.email,
        passwordHash: null
      }))
    }

    yield* orDieStorage(store.createExternalIdentity({
      provider: "google",
      providerSubject: identity.success.providerSubject,
      subjectId: login.subjectId,
      tenantId: login.tenantId,
      email: identity.success.email
    }))
    const handoffHash = state.handoffHash
    if (handoffHash !== null) {
      const completed = yield* orDieStorage(store.completeLoginHandoff({
        requestHash: LoginHandoffHash.make(handoffHash),
        subjectId: login.subjectId,
        tenantId: login.tenantId,
        email: login.email
      }))
      if (!completed) {
        return {
          _tag: "page",
          status: 410,
          title: "Terminal sign-in expired",
          message: "Return to the terminal and run `ii login` again."
        } as const
      }
    }
    const session = yield* issueSession(login.subjectId, login.tenantId)
    return {
      _tag: "signedIn",
      handoffHash: state.handoffHash,
      returnPath: state.returnPath,
      token: session.token
    } as const
  })
