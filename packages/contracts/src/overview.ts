import { Schema } from "effect"
import { AuthMethod } from "./integration.ts"
import { Connection } from "./connection.ts"
import { Tool } from "./tool.ts"

/** The aggregates the dashboard reads. */

/** One catalog integration with the connections that authorize it and the tools
 *  those connections expose. An unconnected integration carries an empty
 *  `connections` list, so a reader can tell "known" from "usable". */
export const IntegrationOverview = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  description: Schema.String,
  kind: Schema.String,
  displayUrl: Schema.optional(Schema.String),
  requiresAuthentication: Schema.Boolean,
  authMethods: Schema.Array(AuthMethod),
  connections: Schema.Array(Connection),
  tools: Schema.Array(Tool),
  /** Listing tools reaches the live endpoint, so one failing integration
   *  reports here rather than failing the whole page. */
  toolError: Schema.optional(Schema.String)
})
export type IntegrationOverview = typeof IntegrationOverview.Type

export const IntegrationsResponse = Schema.Struct({
  generatedAt: Schema.String,
  integrations: Schema.Array(IntegrationOverview),
  error: Schema.optional(Schema.String)
})
export type IntegrationsResponse = typeof IntegrationsResponse.Type


