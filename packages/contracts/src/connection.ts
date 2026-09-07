import { Schema } from "effect"
import { ConnectionName, IntegrationSlug, OwnerTier } from "./vocabulary.ts"

/** A stored authorization letting a tenant use an integration.
 *
 *  Holds references exchanged for credentials at the moment of use, never a
 *  credential value. `oauthScope` is a summary of access, not a token. */
export const Connection = Schema.Struct({
  owner: OwnerTier,
  // Branded because a connection read out of the host is routinely handed back
  // to it — removing one, listing its tools. Unbranded, every such round trip
  // had to re-validate a value the host itself wrote, and a stored name that no
  // longer matched the pattern became an exception at the call site rather than
  // a decode failure at the boundary.
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
