import { InvalidInput, NotFound, NotImplemented } from "@integragents/contracts"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { OAuthConsentDecision, OAuthConsentView, OAuthGrantId, OAuthGrantView } from "@integragents/contracts"
import { Authority } from "../middleware.ts"
import { RequiredAccess } from "../identity.ts"

export const OAuthGroup = HttpApiGroup.make("oauth")
  .add(
    HttpApiEndpoint.get("consent", "/v1/oauth/authorization-request", {
      query: { id: Schema.String },
      success: OAuthConsentView,
      error: [NotFound, NotImplemented]
    }).annotate(RequiredAccess, "human")
  )
  .add(
    HttpApiEndpoint.post("decideConsent", "/v1/oauth/authorization-request", {
      query: { id: Schema.String },
      payload: OAuthConsentDecision,
      success: Schema.Struct({ redirect: Schema.String }),
      error: [NotFound, NotImplemented, InvalidInput]
    }).annotate(RequiredAccess, "human")
  )
  .add(
    HttpApiEndpoint.get("deviceConsent", "/v1/oauth/device-request", {
      query: { code: Schema.String },
      success: OAuthConsentView,
      error: [NotFound, NotImplemented]
    }).annotate(RequiredAccess, "human")
  )
  .add(
    HttpApiEndpoint.post("decideDeviceConsent", "/v1/oauth/device-request", {
      query: { code: Schema.String },
      payload: OAuthConsentDecision,
      success: Schema.Struct({ approved: Schema.Boolean }),
      error: [NotFound, NotImplemented, InvalidInput]
    }).annotate(RequiredAccess, "human")
  )
  .add(
    HttpApiEndpoint.get("listGrants", "/v1/oauth/grants", {
      success: Schema.Struct({ grants: Schema.Array(OAuthGrantView) })
    }).annotate(RequiredAccess, "human")
  )
  .add(
    HttpApiEndpoint.delete("revokeGrant", "/v1/oauth/grants/:id", {
      params: { id: OAuthGrantId },
      success: Schema.Struct({ revoked: Schema.Boolean })
    }).annotate(RequiredAccess, "human")
  )
  .middleware(Authority)
