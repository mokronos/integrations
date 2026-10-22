import { Schema, SchemaTransformation } from "effect"
import {
  ApiKeyId,
  ConnectionName,
  IntegrationSlug,
  OAuthApplicationId,
  OAuthGrantId,
  SubjectId,
  connectionSubject
} from "../domain.ts"
import type { Caller, ConnectionRef } from "../domain.ts"
import type { SqlValue } from "./sql.ts"

export const Millis = Schema.DateFromMillis
export const NullableMillis = Schema.NullOr(Schema.DateFromMillis)
export const millis = (value: Date): number => value.getTime()
export const nullableMillis = (value: Date | null): number | null => (value === null ? null : value.getTime())

/**
 * The expiry a call that waits until someone decides is stored with: the
 * latest instant a Date can hold, so `expires_at > now` stays true without
 * the column admitting a null an older gateway would not expect.
 */
export const neverExpires = 8_640_000_000_000_000

export const expiryMillis = (value: Date | null): number => (value === null ? neverExpires : value.getTime())

export const Expiry = Schema.Number.pipe(
  Schema.decodeTo(
    Schema.NullOr(Schema.Date),
    SchemaTransformation.transform({
      decode: (value: number) => (value >= neverExpires ? null : new Date(value)),
      encode: expiryMillis
    })
  )
)

export const JsonText = Schema.fromJsonString(Schema.Json)
export const NullableJsonText = Schema.NullOr(JsonText)

export const Owner = Schema.Literals(["org", "user"])

/** The four columns a connection is stored in wherever a row names one. */
export const ConnectionColumns = {
  owner: Owner,
  subject: Schema.NullOr(SubjectId),
  integration: IntegrationSlug,
  connection_name: ConnectionName
}

export const connectionOf = (columns: {
  readonly owner: "org" | "user"
  readonly subject: SubjectId | null
  readonly integration: IntegrationSlug
  readonly connection_name: ConnectionName
}): ConnectionRef => {
  const { integration, connection_name: name } = columns
  if (columns.owner === "org") return { owner: "org", integration, name }
  if (columns.subject === null) return { owner: "user", integration, name }
  return { owner: "user", subject: columns.subject, integration, name }
}

export const connectionArgs = (connection: ConnectionRef): ReadonlyArray<SqlValue> => [
  connection.owner,
  connectionSubject(connection) ?? null,
  connection.integration,
  connection.name
]

/** The five columns a call's caller is stored in. */
export const CallerColumns = {
  api_key_id: Schema.NullOr(ApiKeyId),
  oauth_grant_id: Schema.NullOr(OAuthGrantId),
  oauth_application_id: Schema.NullOr(OAuthApplicationId),
  credential_name: Schema.NullOr(Schema.String),
  agent: Schema.NullOr(Schema.String)
}

export const callerOf = (columns: {
  readonly api_key_id: ApiKeyId | null
  readonly oauth_grant_id: OAuthGrantId | null
  readonly oauth_application_id: OAuthApplicationId | null
  readonly credential_name: string | null
  readonly agent: string | null
}): Caller => ({
  apiKeyId: columns.api_key_id,
  oauthGrantId: columns.oauth_grant_id,
  oauthApplicationId: columns.oauth_application_id,
  credentialName: columns.credential_name,
  agent: columns.agent
})

export const callerArgs = (caller: Caller): ReadonlyArray<SqlValue> => [
  caller.apiKeyId,
  caller.oauthGrantId,
  caller.oauthApplicationId,
  caller.credentialName,
  caller.agent
]
