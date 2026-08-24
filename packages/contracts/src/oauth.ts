import { Schema } from "effect"
import { Connection } from "./connection.ts"

/** What an authorization server publishes about itself, and where a started
 *  flow got to. */

export const OAuthServerProbe = Schema.Struct({
  issuer: Schema.optional(Schema.NullOr(Schema.String)),
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  resource: Schema.optional(Schema.NullOr(Schema.String)),
  scopesSupported: Schema.optional(Schema.Array(Schema.String)),
  registrationEndpoint: Schema.optional(Schema.NullOr(Schema.String)),
  tokenEndpointAuthMethodsSupported: Schema.optional(Schema.Array(Schema.String)),
  clientIdMetadataDocumentSupported: Schema.optional(Schema.Boolean)
})
export type OAuthServerProbe = typeof OAuthServerProbe.Type

/** Either the provider short-circuited to a connection that already exists, or
 *  a human has to visit an authorization URL. */
export const OAuthStart = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("connected"),
    connection: Connection
  }),
  Schema.Struct({
    status: Schema.Literal("redirect"),
    authorizationUrl: Schema.String,
    state: Schema.String
  })
])
export type OAuthStart = typeof OAuthStart.Type
