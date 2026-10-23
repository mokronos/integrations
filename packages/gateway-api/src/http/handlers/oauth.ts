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
import { InvalidInput, NotFound, NotImplemented } from "@integragents/contracts"
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
    case "anonymous":
      return Effect.fail(new Forbidden({ code: "not-permitted" }))
  }
})

export const OAuthLayer = HttpApiBuilder.group(GatewayApi, "oauth", (handlers) =>
  Effect.gen(function* () {
    const store = yield* GatewayStoreService
    const issuer = mcpOAuthIssuer(yield* GatewayConfig)
    const requireIssuer =
      issuer === undefined ? Effect.fail(new NotImplemented({ feature: "MCP OAuth" })) : Effect.succeed(issuer)

    return handlers
      .handle("consent", (request) =>
        Effect.gen(function* () {
          yield* requireIssuer
          const { tenantId } = yield* human
          const pending = yield* capture(store.getOAuthAuthorizationRequest(request.query.id))
          if (pending === undefined) return yield* new NotFound({ resource: "oauth-request", id: request.query.id })
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
            profiles: profiles.filter((profile) => profile.revokedAt === null)
          }
        })
      )
      .handle("decideConsent", (request) =>
        Effect.gen(function* () {
          const iss = yield* requireIssuer
          const { tenantId, subjectId } = yield* human
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
          const profile = yield* capture(store.findProfileById(tenantId, decision.profileId))
          if (profile === undefined || profile.revokedAt !== null) {
            return yield* new InvalidInput({ field: "profileId", problem: "that profile is not available" })
          }
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
