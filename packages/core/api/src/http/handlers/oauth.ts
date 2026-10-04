import { DateTime, Duration, Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import {
  defaultLocalSubjectId,
  GatewayStoreService,
  newOAuthAuthorizationCode,
  newOAuthGrantId,
  OAuthSecretHash,
  sha256Hex
} from "@integragents/gateway-core"
import { ApiBadRequest, ApiGone, ApiNotFound, GatewayApi } from "../api.ts"
import { Forbidden, Identity } from "../authority.ts"
import { mcpOAuthIssuer } from "../mcp-oauth.ts"
import { capture } from "../observability.ts"
import { GatewayConfig } from "../services.ts"

const requestSpent = new ApiGone({ error: "Authorization request is expired or already used" })

const human = Effect.flatMap(Identity, (caller) => {
  switch (caller.kind) {
    case "session":
      return Effect.succeed({ tenantId: caller.tenantId, subjectId: caller.subjectId })
    case "local":
      return Effect.succeed({ tenantId: caller.profile.tenantId, subjectId: defaultLocalSubjectId })
    case "key":
    case "anonymous":
      return Effect.fail(Forbidden.of("not-permitted"))
  }
})

export const OAuthLayer = HttpApiBuilder.group(GatewayApi, "oauth", (handlers) =>
  Effect.gen(function*() {
    const store = yield* GatewayStoreService
    const issuer = mcpOAuthIssuer(yield* GatewayConfig)
    const requireIssuer = issuer === undefined
      ? Effect.fail(new ApiNotFound({ error: "MCP OAuth is not enabled on this gateway" }))
      : Effect.succeed(issuer)

    return handlers
      .handle("consent", (request) =>
        Effect.gen(function*() {
          yield* requireIssuer
          const { tenantId } = yield* human
          const pending = yield* capture(store.getOAuthAuthorizationRequest(request.query.id))
          if (pending === undefined) return yield* requestSpent
          const application = yield* capture(store.findOAuthApplicationById(pending.applicationId))
          if (application === undefined) return yield* new ApiGone({ error: "OAuth application is no longer available" })
          const profiles = yield* capture(store.listProfiles(tenantId))
          return {
            request: { id: pending.id, scope: pending.scope, resource: pending.resource },
            application: {
              id: application.id,
              kind: application.kind,
              name: application.name,
              clientIdentifier: application.clientIdentifier
            },
            profiles: profiles.filter((profile) => profile.revokedAt === null)
          }
        }))
      .handle("decideConsent", (request) =>
        Effect.gen(function*() {
          const iss = yield* requireIssuer
          const { tenantId, subjectId } = yield* human
          const id = request.query.id
          const pending = yield* capture(store.getOAuthAuthorizationRequest(id))
          if (pending === undefined) return yield* requestSpent
          const redirect = new URL(pending.redirectUri)
          if (pending.state !== null) redirect.searchParams.set("state", pending.state)
          redirect.searchParams.set("iss", iss)
          const decision = request.payload
          if (decision.decision === "deny") {
            if ((yield* capture(store.consumeOAuthAuthorizationRequest(id))) === undefined) return yield* requestSpent
            redirect.searchParams.set("error", "access_denied")
            return { redirect: redirect.toString() }
          }
          const profile = yield* capture(store.findProfileById(tenantId, decision.profileId))
          if (profile === undefined || profile.revokedAt !== null) {
            return yield* new ApiBadRequest({ error: "That profile is not available" })
          }
          if ((yield* capture(store.consumeOAuthAuthorizationRequest(id))) === undefined) return yield* requestSpent
          const grant = yield* capture(store.findOrCreateOAuthGrant({
            id: yield* newOAuthGrantId,
            applicationId: pending.applicationId,
            subjectId,
            tenantId,
            profileId: profile.id,
            resource: pending.resource,
            scope: pending.scope
          }))
          const code = yield* newOAuthAuthorizationCode
          yield* capture(store.createOAuthAuthorizationCode({
            hash: OAuthSecretHash.make(yield* sha256Hex(code)),
            grantId: grant.id,
            applicationId: grant.applicationId,
            redirectUri: pending.redirectUri,
            codeChallenge: pending.codeChallenge,
            resource: pending.resource,
            scope: pending.scope,
            expiresAt: DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, Duration.minutes(5)))
          }))
          redirect.searchParams.set("code", code)
          return { redirect: redirect.toString() }
        }))
      .handle("listGrants", () =>
        Effect.gen(function*() {
          const { tenantId } = yield* human
          return { grants: yield* capture(store.listOAuthGrants(tenantId)) }
        }))
      .handle("revokeGrant", (request) =>
        Effect.gen(function*() {
          const { tenantId } = yield* human
          return { revoked: yield* capture(store.revokeOAuthGrant(tenantId, request.params.id)) }
        }))
  }))
