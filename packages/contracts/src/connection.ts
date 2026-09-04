import { Schema } from "effect"
import { OwnerTier } from "./vocabulary.ts"

/** A stored authorization letting a tenant use an integration.
 *
 *  Holds references exchanged for credentials at the moment of use, never a
 *  credential value. `oauthScope` is a summary of access, not a token. */
export const Connection = Schema.Struct({
  owner: OwnerTier,
  name: Schema.String,
  integration: Schema.String,
  template: Schema.String,
  address: Schema.String,
  provider: Schema.String,
  identityLabel: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  oauthClient: Schema.optional(Schema.NullOr(Schema.String)),
  oauthClientOwner: Schema.optional(Schema.NullOr(OwnerTier)),
  oauthScope: Schema.optional(Schema.NullOr(Schema.String)),
  missingOAuthScopes: Schema.optional(Schema.Array(Schema.String)),
  expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
  status: Schema.Literals(["connected", "reauthorization_required"]),
  error: Schema.optional(Schema.String)
})
export type Connection = typeof Connection.Type
