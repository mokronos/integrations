import { Schema } from "effect"
import { AuthMethod } from "./integration.ts"
import { Connection } from "./connection.ts"
import { EventType } from "./mcp-events.ts"
import { SkillEntry } from "./resource.ts"
import { Tool } from "./tool.ts"
import { ConnectionName, ConnectionOwner } from "./vocabulary.ts"

export const IntegrationOverview = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  description: Schema.String,
  kind: Schema.String,
  displayUrl: Schema.optional(Schema.String),
  requiresAuthentication: Schema.Boolean,
  authMethods: Schema.Array(AuthMethod),
  savedOAuthClientId: Schema.optional(Schema.String),
  connections: Schema.Array(Connection),
  tools: Schema.Array(Tool),
  /** The event types (MCP Events) its connections' servers listed when their tools were captured. */
  eventTypes: Schema.Array(EventType),
  toolError: Schema.optional(Schema.String)
})
export type IntegrationOverview = typeof IntegrationOverview.Type

/** A skill one connection's server publishes, read live from it. */
export const ConnectionSkill = Schema.Struct({
  owner: ConnectionOwner,
  connection: ConnectionName,
  skill: SkillEntry
})
export type ConnectionSkill = typeof ConnectionSkill.Type

export const IntegrationSkillsResponse = Schema.Struct({
  skills: Schema.Array(ConnectionSkill),
  /** The connections whose servers could not be asked, and why; their skills are left out. */
  error: Schema.optional(Schema.String)
})
export type IntegrationSkillsResponse = typeof IntegrationSkillsResponse.Type

export const IntegrationsResponse = Schema.Struct({
  generatedAt: Schema.String,
  integrations: Schema.Array(IntegrationOverview),
  error: Schema.optional(Schema.String)
})
export type IntegrationsResponse = typeof IntegrationsResponse.Type
