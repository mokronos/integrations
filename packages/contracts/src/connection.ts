import { Schema } from "effect"
import { ConnectionName, IntegrationSlug, OwnerTier } from "./vocabulary.ts"

export const Connection = Schema.Struct({
  owner: OwnerTier,
  name: ConnectionName,
  integration: IntegrationSlug,
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
