import { Schema } from "effect"
import { Connection } from "./connection.ts"

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

export const OAuthSessionPending = Schema.Struct({ status: Schema.Literal("pending"), authorizationUrl: Schema.String })
export type OAuthSessionPending = typeof OAuthSessionPending.Type
export const OAuthSessionConnected = Schema.Struct({ status: Schema.Literal("connected"), connection: Connection })
export type OAuthSessionConnected = typeof OAuthSessionConnected.Type
export const OAuthSessionFailed = Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String })
export type OAuthSessionFailed = typeof OAuthSessionFailed.Type
export const OAuthSessionNeedsClient = Schema.Struct({
  status: Schema.Literal("needs-client"),
  setupUrl: Schema.String,
  guidance: Schema.String
})
export type OAuthSessionNeedsClient = typeof OAuthSessionNeedsClient.Type
export const OAuthClientSubmission = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.optional(Schema.String)
})
export type OAuthClientSubmission = typeof OAuthClientSubmission.Type
export const OAuthSessionState = Schema.Union([
  OAuthSessionPending,
  OAuthSessionConnected,
  OAuthSessionFailed,
  OAuthSessionNeedsClient
])
export type OAuthSessionState = typeof OAuthSessionState.Type
export const OAuthSessionView = Schema.Struct({
  id: Schema.String,
  integration: Schema.String,
  connection: Schema.String,
  state: OAuthSessionState
})
export type OAuthSessionView = typeof OAuthSessionView.Type
