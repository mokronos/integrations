import { Schema } from "effect"

/** Identifiers that exist only inside the host.
 *
 *  The shared vocabulary — integration slugs, connection names, tool names and
 *  addresses — lives in `@mokronos/contracts`, because the gateway and the
 *  published client name those too. What is left here is the catalog's own
 *  bookkeeping, which nothing outside the host ever spells. */

/** Which auth shape a connection was created against: `none`, `bearer`, or an
 *  OpenAPI security scheme's name. */
export const AuthTemplateSlug = Schema.String.pipe(
  Schema.refine((value): value is string => value.length > 0),
  Schema.brand("AuthTemplateSlug")
)
export type AuthTemplateSlug = typeof AuthTemplateSlug.Type

export const OAuthClientSlug = Schema.String.pipe(
  Schema.refine((value): value is string => value.length > 0),
  Schema.brand("OAuthClientSlug")
)
export type OAuthClientSlug = typeof OAuthClientSlug.Type

/** The opaque CSRF value tying an authorization redirect back to the pending
 *  flow that started it. Single-use: reading it deletes it. */
export const OAuthState = Schema.String.pipe(
  Schema.refine((value): value is string => value.length > 0),
  Schema.brand("OAuthState")
)
export type OAuthState = typeof OAuthState.Type
