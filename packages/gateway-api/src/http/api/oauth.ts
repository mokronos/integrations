import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { OAuthConsentDecision, OAuthConsentView, OAuthGrantId, OAuthGrantView } from "@integragents/contracts"
import { Authority } from "../middleware.ts"
import { RequiredAccess } from "../identity.ts"
import { ApiBadRequestError, ApiNotFoundError } from "./shared.ts"

export class ApiGone extends Schema.TaggedError<ApiGone>()("ApiGone", { error: Schema.String }) {}
const ApiGoneError = ApiGone.pipe(HttpApiSchema.status(410))

export const OAuthGroup = HttpApiGroup.make("oauth")
  .add(
    HttpApiEndpoint.get("consent", "/v1/oauth/authorization-request", {
      query: { id: Schema.String },
      success: OAuthConsentView,
      error: [ApiNotFoundError, ApiGoneError]
    }).annotate(RequiredAccess, "human")
  )
  .add(
    HttpApiEndpoint.post("decideConsent", "/v1/oauth/authorization-request", {
      query: { id: Schema.String },
      payload: OAuthConsentDecision,
      success: Schema.Struct({ redirect: Schema.String }),
      error: [ApiNotFoundError, ApiGoneError, ApiBadRequestError]
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
