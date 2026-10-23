import { NotFound } from "@integragents/contracts"
import { Effect, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import {
  IntegrationError,
  NotImplemented,
  OAuthClientSubmission,
  OAuthSessionView,
  SubjectId
} from "@integragents/contracts"
import {
  Connection,
  Integration,
  IntegrationDiscovery,
  IntegrationSearchKind,
  IntegrationSearchResponse,
  IntegrationValidationReport,
  IntegrationOverview,
  PositiveInt,
  PositiveIntFromString,
  Tool,
  ToolSummary
} from "@integragents/contracts"
import { Authority } from "../middleware.ts"
import { RequiredAccess } from "../identity.ts"
import { Json } from "./shared.ts"

const DiscoverBody = Schema.Struct({
  url: Schema.String,
  connection: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String)
})

const RenameIntegrationBody = Schema.Struct({ name: Schema.String })

const ConnectBody = Schema.Struct({
  integration: Schema.String,
  connection: Schema.optional(Schema.String),
  template: Schema.optional(Schema.String),
  values: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Connect on behalf of one person rather than the organisation. */
  subject: Schema.optional(SubjectId)
})

const OAuthStartBody = Schema.Struct({
  integration: Schema.String,
  connection: Schema.optional(Schema.String),
  template: Schema.optional(Schema.String),
  subject: Schema.optional(SubjectId),
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  timeoutSeconds: Schema.optional(Schema.Number)
})

const ValidateBody = Schema.Struct({
  node: Json,
  live: Schema.optional(Schema.Boolean)
})

/** The gateway as an OAuth client, for authorization servers that take a client ID metadata document as the client id. */
const OAuthClientMetadataDocument = Schema.Struct({
  client_id: Schema.String,
  client_name: Schema.String,
  redirect_uris: Schema.Array(Schema.String),
  grant_types: Schema.Array(Schema.String),
  response_types: Schema.Array(Schema.String),
  token_endpoint_auth_method: Schema.Literal("none")
})

const ValidationFinding = Schema.Struct({
  severity: Schema.String,
  check: Schema.String,
  message: Schema.String
})
const ValidationReport = Schema.Struct({
  ok: Schema.Boolean,
  findings: Schema.Array(ValidationFinding)
})

export const ProvisioningGroup = HttpApiGroup.make("provisioning")
  .add(
    HttpApiEndpoint.get("listIntegrations", "/v1/integrations", {
      success: Schema.Struct({
        integrations: Schema.Array(IntegrationOverview),
        oauthCallbackUrl: Schema.optional(Schema.NullOr(Schema.String))
      })
    }).annotate(RequiredAccess, "provisioning")
  )
  .add(
    HttpApiEndpoint.post("discover", "/v1/integrations/discover", {
      payload: DiscoverBody,
      success: HttpApiSchema.status(201)(IntegrationDiscovery),
      error: IntegrationError.members
    }).annotate(RequiredAccess, "provisioning")
  )
  .add(
    HttpApiEndpoint.get("integrationTools", "/v1/integrations/:slug/tools", {
      params: { slug: Schema.String },
      success: Schema.Struct({ tools: Schema.Array(ToolSummary) }),
      error: NotFound
    }).annotate(RequiredAccess, "provisioning")
  )
  .add(
    HttpApiEndpoint.get("describeTool", "/v1/integrations/:slug/tools/:tool", {
      params: { slug: Schema.String, tool: Schema.String },
      query: { connection: Schema.optional(Schema.String) },
      success: Tool,
      error: IntegrationError.members
    }).annotate(RequiredAccess, "provisioning")
  )
  .add(
    HttpApiEndpoint.get("registrySearch", "/v1/registry/search", {
      query: {
        q: Schema.String,
        limit: PositiveIntFromString.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(PositiveInt.make(5)))),
        kind: Schema.optional(IntegrationSearchKind)
      },
      success: IntegrationSearchResponse,
      error: IntegrationError.members
    }).annotate(RequiredAccess, "provisioning")
  )
  .add(
    HttpApiEndpoint.post("validate", "/v1/validate", {
      payload: ValidateBody,
      success: Schema.Union([ValidationReport, IntegrationValidationReport])
    }).annotate(RequiredAccess, "provisioning")
  )
  .add(
    HttpApiEndpoint.get("listConnections", "/v1/connections", {
      success: Schema.Struct({ connections: Schema.Array(Connection) })
    }).annotate(RequiredAccess, "provisioning")
  )
  .add(
    HttpApiEndpoint.post("connect", "/v1/connections", {
      payload: ConnectBody,
      success: HttpApiSchema.status(201)(
        Schema.Struct({
          connection: Connection,
          tools: Schema.Array(ToolSummary)
        })
      ),
      error: IntegrationError.members
    }).annotate(RequiredAccess, "provisioning")
  )
  .add(
    HttpApiEndpoint.post("startOAuth", "/v1/connections/oauth", {
      payload: OAuthStartBody,
      success: HttpApiSchema.status(201)(OAuthSessionView),
      error: IntegrationError.members
    }).annotate(RequiredAccess, "provisioning")
  )
  .add(
    HttpApiEndpoint.get("oauthSession", "/v1/connections/oauth/:id", {
      params: { id: Schema.String },
      success: OAuthSessionView,
      error: NotFound
    }).annotate(RequiredAccess, "provisioning")
  )
  .add(
    HttpApiEndpoint.post("provideOAuthClient", "/v1/connections/oauth/:id/client", {
      params: { id: Schema.String },
      payload: OAuthClientSubmission,
      success: OAuthSessionView,
      error: IntegrationError.members
    }).annotate(RequiredAccess, "provisioning")
  )
  .add(
    HttpApiEndpoint.get("oauthClientMetadata", "/v1/oauth/client-metadata.json", {
      success: OAuthClientMetadataDocument,
      error: [NotFound, NotImplemented]
    }).annotate(RequiredAccess, "public")
  )
  .add(
    HttpApiEndpoint.get("oauthCallback", "/v1/oauth/callback", {
      query: {
        state: Schema.optional(Schema.String),
        code: Schema.optional(Schema.String),
        error_description: Schema.optional(Schema.String),
        error: Schema.optional(Schema.String)
      },
      success: Schema.Struct({ rendered: Schema.Literal(true) })
    }).annotate(RequiredAccess, "public")
  )
  .add(
    HttpApiEndpoint.post("renameIntegration", "/v1/integrations/:slug/name", {
      params: { slug: Schema.String },
      payload: RenameIntegrationBody,
      success: Integration,
      error: NotFound
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.delete("removeIntegration", "/v1/integrations/:slug", {
      params: { slug: Schema.String },
      success: Schema.Struct({
        removed: Schema.Literal(true),
        integration: Schema.String,
        connections: Schema.Array(Schema.String)
      }),
      error: NotFound
    }).annotate(RequiredAccess, "provisioning")
  )
  .add(
    HttpApiEndpoint.delete("removeConnection", "/v1/connections/:integration/:name", {
      params: { integration: Schema.String, name: Schema.String },
      success: Schema.Struct({
        removed: Schema.Literal(true),
        integration: Schema.String,
        connection: Schema.String
      }),
      error: NotFound
    }).annotate(RequiredAccess, "provisioning")
  )
  .middleware(Authority)
