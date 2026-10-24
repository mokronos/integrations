import { DateTime, Duration, Effect } from "effect"
import type { OAuthApplicationId, ProfileId, SubjectId, TenantId } from "@integragents/contracts"
import { HttpApiBuilder } from "effect/http-api"
import {
  defaultLocalSubjectId,
  GatewayStoreService,
  newOAuthAuthorizationCode,
  newOAuthGrantId,
  OAuthSecretHash,
  sha256Hex
} from "@integragents/gateway-core"
import { InvalidInput, NotFound, NotImplemented, profileActsFor } from "@integragents/contracts"
import { GatewayApi } from "../api.ts"
import { Forbidden, Identity } from "../authority.ts"
import { mcpOAuthIssuer } from "../authorization-server.ts"
import { capture } from "../observability.ts"
import { GatewayConfig } from "../services.ts"

const human = Effect.flatMap(Identity, (caller) => {
  switch (caller.kind) {
    case "session":
      return Effect.succeed({ tenantId: caller.tenantId, subjectId: caller.subjectId })
    case "local":
      return Effect.succeed({ tenantId: caller.profile.tenantId, subjectId: defaultLocalSubjectId })
    case "key":
    case "grant":
    case "anonymous":
      return Effect.fail(new Forbidden({ code: "not-permitted" }))
  }
})

/** A user code as a person may type it: any case, with or without the dash, with stray spaces. */
const normalizeUserCode = (typed: string): string => {
  const letters = typed.toUpperCase().replace(/[^A-Z]/g, "")
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : typed
}

export const OAuthLayer = HttpApiBuilder.group(GatewayApi, "oauth", (handlers) =>
  Effect.gen(function* () {
    const store = yield* GatewayStoreService
    const issuer = mcpOAuthIssuer(yield* GatewayConfig)
    const requireIssuer =
      issuer === undefined ? Effect.fail(new NotImplemented({ feature: "MCP OAuth" })) : Effect.succeed(issuer)

    /** What a person is asked to approve: the application, and the profiles it could act as. */
    const consentView = (
      { tenantId, subjectId }: { readonly tenantId: TenantId; readonly subjectId: SubjectId },
      pending: {
        readonly id: string
        readonly applicationId: OAuthApplicationId
        readonly resource: string
        readonly scope: "mcp"
      }
    ) =>
      Effect.gen(function* () {
        const application = yield* capture(store.findOAuthApplicationById(pending.applicationId))
        if (application === undefined)
          return yield* new NotFound({ resource: "oauth-application", id: pending.applicationId })
        const profiles = yield* capture(store.listProfiles(tenantId))
        return {
          request: { id: pending.id, scope: pending.scope, resource: pending.resource },
          application: {
            id: application.id,
            kind: application.kind,
            name: application.name,
            clientIdentifier: application.clientIdentifier
          },
          profiles: profiles.filter((profile) => profile.revokedAt === null && profileActsFor(profile, subjectId))
        }
      })

    /** A profile the approving person may hand out: live, and acting for them. */
    const liveProfile = (
      { tenantId, subjectId }: { readonly tenantId: TenantId; readonly subjectId: SubjectId },
      decision: { readonly profileId: ProfileId }
    ) =>
      Effect.gen(function* () {
        const profile = yield* capture(store.findProfileById(tenantId, decision.profileId))
        if (profile === undefined || profile.revokedAt !== null || !profileActsFor(profile, subjectId)) {
          return yield* new InvalidInput({ field: "profileId", problem: "that profile is not available" })
        }
        return profile
      })

    return handlers
      .handle("consent", (request) =>
        Effect.gen(function* () {
          yield* requireIssuer
          const person = yield* human
          const pending = yield* capture(store.getOAuthAuthorizationRequest(request.query.id))
          if (pending === undefined) return yield* new NotFound({ resource: "oauth-request", id: request.query.id })
          return yield* consentView(person, pending)
        })
      )
      .handle("deviceConsent", (request) =>
        Effect.gen(function* () {
          yield* requireIssuer
          const person = yield* human
          const userCode = normalizeUserCode(request.query.code)
          const pending = yield* capture(store.findPendingOAuthDeviceRequest(userCode))
          if (pending === undefined) return yield* new NotFound({ resource: "oauth-request", id: userCode })
          return yield* consentView(person, { ...pending, id: pending.userCode })
        })
      )
      .handle("decideDeviceConsent", (request) =>
        Effect.gen(function* () {
          yield* requireIssuer
          const person = yield* human
          const { tenantId, subjectId } = person
          const userCode = normalizeUserCode(request.query.code)
          const decision = request.payload
          if (decision.decision === "deny") {
            const denied = yield* capture(store.decideOAuthDeviceRequest(userCode, null))
            if (denied === undefined) return yield* new NotFound({ resource: "oauth-request", id: userCode })
            return { approved: false }
          }
          const profile = yield* liveProfile(person, decision)
          const pending = yield* capture(store.findPendingOAuthDeviceRequest(userCode))
          if (pending === undefined) return yield* new NotFound({ resource: "oauth-request", id: userCode })
          const grant = yield* capture(
            store.findOrCreateOAuthGrant({
              id: yield* newOAuthGrantId,
              applicationId: pending.applicationId,
              subjectId,
              tenantId,
              profileId: profile.id,
              resource: pending.resource,
              scope: pending.scope
            })
          )
          const approved = yield* capture(store.decideOAuthDeviceRequest(userCode, grant.id))
          if (approved === undefined) return yield* new NotFound({ resource: "oauth-request", id: userCode })
          return { approved: true }
        })
      )
      .handle("decideConsent", (request) =>
        Effect.gen(function* () {
          const iss = yield* requireIssuer
          const person = yield* human
          const { tenantId, subjectId } = person
          const id = request.query.id
          const pending = yield* capture(store.getOAuthAuthorizationRequest(id))
          if (pending === undefined) return yield* new NotFound({ resource: "oauth-request", id: request.query.id })
          const redirect = new URL(pending.redirectUri)
          if (pending.state !== null) redirect.searchParams.set("state", pending.state)
          redirect.searchParams.set("iss", iss)
          const decision = request.payload
          if (decision.decision === "deny") {
            if ((yield* capture(store.consumeOAuthAuthorizationRequest(id))) === undefined)
              return yield* new NotFound({ resource: "oauth-request", id: request.query.id })
            redirect.searchParams.set("error", "access_denied")
            return { redirect: redirect.toString() }
          }
          const profile = yield* liveProfile(person, decision)
          if ((yield* capture(store.consumeOAuthAuthorizationRequest(id))) === undefined)
            return yield* new NotFound({ resource: "oauth-request", id: request.query.id })
          const grant = yield* capture(
            store.findOrCreateOAuthGrant({
              id: yield* newOAuthGrantId,
              applicationId: pending.applicationId,
              subjectId,
              tenantId,
              profileId: profile.id,
              resource: pending.resource,
              scope: pending.scope
            })
          )
          const code = yield* newOAuthAuthorizationCode
          yield* capture(
            store.createOAuthAuthorizationCode({
              hash: OAuthSecretHash.make(yield* sha256Hex(code)),
              grantId: grant.id,
              applicationId: grant.applicationId,
              redirectUri: pending.redirectUri,
              codeChallenge: pending.codeChallenge,
              resource: pending.resource,
              scope: pending.scope,
              expiresAt: DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, Duration.minutes(5)))
            })
          )
          redirect.searchParams.set("code", code)
          return { redirect: redirect.toString() }
        })
      )
      .handle("listGrants", () =>
        Effect.gen(function* () {
          const { tenantId } = yield* human
          return { grants: yield* capture(store.listOAuthGrants(tenantId)) }
        })
      )
      .handle("revokeGrant", (request) =>
        Effect.gen(function* () {
          const { tenantId } = yield* human
          return { revoked: yield* capture(store.revokeOAuthGrant(tenantId, request.params.id)) }
        })
      )
  })
)
