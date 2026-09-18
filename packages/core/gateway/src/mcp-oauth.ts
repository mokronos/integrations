import { Schema } from "effect"
import {
  ClientId,
  OAuthApplicationId,
  OAuthApplicationKind,
  OAuthGrantId,
  SubjectId,
  TenantId
} from "@integrations/contracts"

export const OAuthSecretHash = Schema.String.pipe(Schema.brand("OAuthSecretHash"))
export type OAuthSecretHash = typeof OAuthSecretHash.Type

export const OAuthApplication = Schema.Struct({
  id: OAuthApplicationId,
  kind: OAuthApplicationKind,
  clientIdentifier: Schema.String,
  name: Schema.String,
  redirectUris: Schema.Array(Schema.String),
  metadata: Schema.Json,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
  revokedAt: Schema.NullOr(Schema.Date)
})
export type OAuthApplication = typeof OAuthApplication.Type

export const OAuthAuthorizationRequest = Schema.Struct({
  id: Schema.String,
  applicationId: OAuthApplicationId,
  redirectUri: Schema.String,
  state: Schema.NullOr(Schema.String),
  codeChallenge: Schema.String,
  resource: Schema.String,
  scope: Schema.Literal("mcp"),
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
  consumedAt: Schema.NullOr(Schema.Date)
})
export type OAuthAuthorizationRequest = typeof OAuthAuthorizationRequest.Type

export const OAuthGrant = Schema.Struct({
  id: OAuthGrantId,
  applicationId: OAuthApplicationId,
  subjectId: SubjectId,
  tenantId: TenantId,
  clientId: ClientId,
  resource: Schema.String,
  scope: Schema.Literal("mcp"),
  createdAt: Schema.Date,
  lastUsedAt: Schema.NullOr(Schema.Date),
  revokedAt: Schema.NullOr(Schema.Date)
})
export type OAuthGrant = typeof OAuthGrant.Type

export const OAuthAuthorizationCode = Schema.Struct({
  hash: OAuthSecretHash,
  grantId: OAuthGrantId,
  applicationId: OAuthApplicationId,
  redirectUri: Schema.String,
  codeChallenge: Schema.String,
  resource: Schema.String,
  scope: Schema.Literal("mcp"),
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
  consumedAt: Schema.NullOr(Schema.Date)
})
export type OAuthAuthorizationCode = typeof OAuthAuthorizationCode.Type

export const OAuthTokenKind = Schema.Literals(["access", "refresh"])
export type OAuthTokenKind = typeof OAuthTokenKind.Type
export const OAuthToken = Schema.Struct({
  hash: OAuthSecretHash,
  kind: OAuthTokenKind,
  familyId: Schema.String,
  grantId: OAuthGrantId,
  applicationId: OAuthApplicationId,
  resource: Schema.String,
  scope: Schema.Literal("mcp"),
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
  usedAt: Schema.NullOr(Schema.Date),
  revokedAt: Schema.NullOr(Schema.Date),
  replacedByHash: Schema.NullOr(OAuthSecretHash)
})
export type OAuthToken = typeof OAuthToken.Type

export const OAuthActor = Schema.Struct({
  grantId: OAuthGrantId,
  applicationId: OAuthApplicationId,
  subjectId: SubjectId
})
export type OAuthActor = typeof OAuthActor.Type
