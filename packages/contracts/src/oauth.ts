import { Schema } from "effect"
import { Connection } from "./connection.ts"

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
