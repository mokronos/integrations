import { Schema } from "effect"

export const AuthTemplateSlug = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("AuthTemplateSlug"))
export type AuthTemplateSlug = typeof AuthTemplateSlug.Type

export const OAuthClientSlug = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("OAuthClientSlug"))
export type OAuthClientSlug = typeof OAuthClientSlug.Type

export const gatewayOAuthClientSlug = (integration: string): OAuthClientSlug =>
  OAuthClientSlug.make(`${integration}-gateway`)

export const OAuthState = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("OAuthState"))
export type OAuthState = typeof OAuthState.Type
