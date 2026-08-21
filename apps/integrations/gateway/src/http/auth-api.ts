import { Schema } from "effect"
import { generateSessionToken, hashPassword, verifyPassword } from "../passwords.ts"
import { newSubjectId, newTenantId } from "../keys.ts"
import type { GatewayStore } from "../store.ts"
import { badRequest, created, decodeBody, ok } from "./router.ts"
import type { Route } from "./router.ts"
import {
  clearedSessionCookieHeader,
  sessionCookieHeader
} from "./handler.ts"

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

export interface AuthDependencies {
  readonly store: GatewayStore
  /** Whether POST /v1/auth/signup may create a new tenant. True while the
   *  gateway has no logins at all (so its first human can claim it) and after
   *  that only when an operator opts in. */
  readonly signupOpen: boolean
  /** Set on session cookies when the gateway is served over TLS. */
  readonly secureCookies: boolean
  readonly sessionTtlHours?: number
}

const defaultSessionTtlHours = 24 * 30

/** The login surface. Public by necessity — these routes are how a credential
 *  comes to exist — and deliberately small.
 *
 * Failures do not distinguish "unknown email" from "wrong password". The
 * difference is an enumeration oracle for anyone harvesting credentials, and
 * the human who needs to know already knows which one it was. */
export const authRoutes = (dependencies: AuthDependencies): ReadonlyArray<Route> => {
  const ttlHours = dependencies.sessionTtlHours ?? defaultSessionTtlHours

  const startSession = async (
    subjectId: Parameters<GatewayStore["createSession"]>[0]["subjectId"],
    tenantId: Parameters<GatewayStore["createSession"]>[0]["tenantId"]
  ): Promise<string> => {
    const token = generateSessionToken()
    await dependencies.store.createSession({
      tokenHash: token.hash,
      subjectId,
      tenantId,
      expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000)
    })
    return sessionCookieHeader(token.secret, {
      maxAgeSeconds: Math.round(ttlHours * 60 * 60),
      secure: dependencies.secureCookies
    })
  }

  return [
    {
      method: "POST",
      path: "/v1/auth/signup",
      access: "public",
      handle: async (request) => {
        if (!dependencies.signupOpen) {
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
        const accepted = login !== undefined &&
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
          return ok({
            authenticated: true,
            kind: "session",
            email: request.identity.email,
            tenantId: request.identity.tenantId,
            subjectId: request.identity.subjectId
          })
        }
        if (request.identity.kind === "client") {
          return ok({
            authenticated: true,
            kind: "client",
            clientId: request.identity.client.id,
            tenantId: request.identity.client.tenantId,
            mayMutate: request.identity.client.mayMutate
          })
        }
        return ok({ authenticated: false })
      }
    }
  ]
}
