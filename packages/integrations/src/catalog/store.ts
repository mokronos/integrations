import { Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import { Database } from "../storage/database.ts"
import type { SqlRow, SqlStatement, SqlValue } from "../storage/database.ts"
import { StorageError } from "../errors.ts"
import { AuthTemplateSlug, OAuthClientSlug, OAuthState } from "./ids.ts"
import {
  AuthMethod,
  ConnectionName,
  IntegrationKind,
  IntegrationSlug,
  OwnerTier,
  ToolAddress,
  whenPresent
} from "@mokronos/contracts"
import { Tool, ToolCall } from "@mokronos/core-integrations"
import type { Tool as IntegrationTool } from "@mokronos/core-integrations"

/** The catalog's row layer: every persisted shape the host owns, decoded on the
 *  way out and parameterised on the way in.
 *
 *  No column here ever holds a credential. An OAuth client's secret and a
 *  connection's token both live in the credential store, keyed by address, so a
 *  database dump is not a secret spill. */

export const IntegrationRecord = Schema.Struct({
  slug: IntegrationSlug,
  name: Schema.String,
  description: Schema.String,
  kind: IntegrationKind,
  /** The MCP endpoint; absent for OpenAPI integrations. */
  endpoint: Schema.optional(Schema.String),
  /** Where the OpenAPI or Discovery document was loaded from. */
  specSource: Schema.optional(Schema.String),
  specFormat: Schema.optional(Schema.Literals(["openapi", "google-discovery"])),
  /** Overrides the server the document declares. */
  baseUrl: Schema.optional(Schema.String),
  displayUrl: Schema.optional(Schema.String),
  authMethods: Schema.Array(AuthMethod),
  createdAt: Schema.Number
})
export type IntegrationRecord = typeof IntegrationRecord.Type

export const ConnectionRecord = Schema.Struct({
  owner: OwnerTier,
  integration: IntegrationSlug,
  name: ConnectionName,
  template: AuthTemplateSlug,
  provider: Schema.String,
  identityLabel: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  oauthClient: Schema.optional(Schema.String),
  oauthClientOwner: Schema.optional(OwnerTier),
  oauthScope: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Number),
  createdAt: Schema.Number
})
export type ConnectionRecord = typeof ConnectionRecord.Type

export const OAuthClientRecord = Schema.Struct({
  owner: OwnerTier,
  slug: OAuthClientSlug,
  integration: IntegrationSlug,
  clientId: Schema.String,
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  registrationEndpoint: Schema.optional(Schema.String),
  issuer: Schema.optional(Schema.String),
  resource: Schema.optional(Schema.String),
  scopes: Schema.Array(Schema.String),
  tokenAuthMethods: Schema.Array(Schema.String)
})
export type OAuthClientRecord = typeof OAuthClientRecord.Type

/** One authorization in flight. Holds the PKCE verifier and everything needed
 *  to finish the exchange when the browser comes back with a code. */
export const OAuthFlowRecord = Schema.Struct({
  state: OAuthState,
  owner: OwnerTier,
  integration: IntegrationSlug,
  connection: ConnectionName,
  template: AuthTemplateSlug,
  clientOwner: OwnerTier,
  clientSlug: OAuthClientSlug,
  codeVerifier: Schema.String,
  redirectUri: Schema.String,
  resource: Schema.optional(Schema.String),
  scopes: Schema.Array(Schema.String)
})
export type OAuthFlowRecord = typeof OAuthFlowRecord.Type

/** SQL has no undefined, so absent optionals persist as NULL and read back as
 *  absent rather than as an explicit null. */
const nullable = (value: string | number | undefined): SqlValue => value ?? null

const text = (row: SqlRow, column: string): string => {
  const value = row[column]
  return Predicate.isString(value) ? value : String(value ?? "")
}

/** An empty string and a NULL both read as absent: the host never stores a
 *  meaningful empty value in a nullable column. */
const optionalText = (row: SqlRow, column: string): string | undefined => {
  const value = row[column]
  return Predicate.isString(value) && value.length > 0 ? value : undefined
}

const number = (row: SqlRow, column: string): number => {
  const value = row[column]
  return Predicate.isNumber(value) ? value : Number(value ?? 0)
}

const optionalNumber = (row: SqlRow, column: string): number | undefined => {
  const value = row[column]
  return Predicate.isNumber(value) ? value : undefined
}

const decodeJsonArray = <A>(schema: Schema.Codec<A>) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(schema)))
  return (raw: string, column: string): Effect.Effect<ReadonlyArray<A>, StorageError> =>
    decode(raw.length === 0 ? "[]" : raw).pipe(
      Effect.mapError((cause) =>
        new StorageError({ message: `Malformed ${column} column`, cause })
      )
    )
}

const decodeAuthMethods = decodeJsonArray(AuthMethod)
const decodeStrings = decodeJsonArray(Schema.String)

const decodeIntegrationRow = (row: SqlRow) =>
  Effect.gen(function* () {
    const authMethods = yield* decodeAuthMethods(text(row, "auth_methods"), "auth_methods")
    return yield* Schema.decodeUnknownEffect(IntegrationRecord)({
      slug: text(row, "slug"),
      name: text(row, "name"),
      description: text(row, "description"),
      kind: text(row, "kind"),
      ...whenPresent("endpoint", optionalText(row, "endpoint")),
      ...whenPresent("specSource", optionalText(row, "spec_source")),
      ...whenPresent("specFormat", optionalText(row, "spec_format")),
      ...whenPresent("baseUrl", optionalText(row, "base_url")),
      ...whenPresent("displayUrl", optionalText(row, "display_url")),
      authMethods,
      createdAt: number(row, "created_at")
    }).pipe(Effect.mapError((cause) =>
      new StorageError({ message: `Malformed integration row ${text(row, "slug")}`, cause })
    ))
  })

const decodeConnectionRow = (row: SqlRow) =>
  Schema.decodeUnknownEffect(ConnectionRecord)({
    owner: text(row, "owner"),
    integration: text(row, "integration"),
    name: text(row, "name"),
    template: text(row, "template"),
    provider: text(row, "provider"),
    ...whenPresent("identityLabel", optionalText(row, "identity_label")),
    ...whenPresent("description", optionalText(row, "description")),
    ...whenPresent("oauthClient", optionalText(row, "oauth_client")),
    ...whenPresent("oauthClientOwner", optionalText(row, "oauth_client_owner")),
    ...whenPresent("oauthScope", optionalText(row, "oauth_scope")),
    ...whenPresent("expiresAt", optionalNumber(row, "expires_at")),
    createdAt: number(row, "created_at")
  }).pipe(Effect.mapError((cause) =>
    new StorageError({ message: `Malformed connection row ${text(row, "name")}`, cause })
  ))

const decodeOAuthClientRow = (row: SqlRow) =>
  Effect.gen(function* () {
    const scopes = yield* decodeStrings(text(row, "scopes"), "scopes")
    const tokenAuthMethods = yield* decodeStrings(
      text(row, "token_auth_methods"),
      "token_auth_methods"
    )
    return yield* Schema.decodeUnknownEffect(OAuthClientRecord)({
      owner: text(row, "owner"),
      slug: text(row, "slug"),
      integration: text(row, "integration"),
      clientId: text(row, "client_id"),
      authorizationUrl: text(row, "authorization_url"),
      tokenUrl: text(row, "token_url"),
      ...whenPresent("registrationEndpoint", optionalText(row, "registration_endpoint")),
      ...whenPresent("issuer", optionalText(row, "issuer")),
      ...whenPresent("resource", optionalText(row, "resource")),
      scopes,
      tokenAuthMethods
    }).pipe(Effect.mapError((cause) =>
      new StorageError({ message: `Malformed oauth_client row ${text(row, "slug")}`, cause })
    ))
  })

const decodeJsonColumn = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))
const decodeCall = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolCall))

const decodeToolRow = (row: SqlRow) =>
  Effect.gen(function* () {
    const call = yield* decodeCall(text(row, "call")).pipe(
      Effect.mapError((cause) =>
        new StorageError({ message: `Malformed call for ${text(row, "address")}`, cause })
      )
    )
    const optionalJson = (column: string) =>
      Effect.gen(function* () {
        const raw = optionalText(row, column)
        if (raw === undefined) return undefined
        return yield* decodeJsonColumn(raw).pipe(
          Effect.mapError((cause) =>
            new StorageError({ message: `Malformed ${column} for ${text(row, "address")}`, cause })
          )
        )
      })
    const inputSchema = yield* optionalJson("input_schema")
    const outputSchema = yield* optionalJson("output_schema")
    return yield* Schema.decodeUnknownEffect(Tool)({
      address: text(row, "address"),
      owner: text(row, "owner"),
      integration: text(row, "integration"),
      connection: text(row, "connection"),
      name: text(row, "name"),
      description: text(row, "description"),
      readOnly: number(row, "read_only") === 1,
      ...whenPresent("inputSchema", inputSchema),
      ...whenPresent("outputSchema", outputSchema),
      call,
      capturedAt: number(row, "captured_at")
    }).pipe(Effect.mapError((cause) =>
      new StorageError({ message: `Malformed tool row ${text(row, "address")}`, cause })
    ))
  })

const decodeOAuthFlowRow = (row: SqlRow) =>
  Effect.gen(function* () {
    const scopes = yield* decodeStrings(text(row, "scopes"), "scopes")
    return yield* Schema.decodeUnknownEffect(OAuthFlowRecord)({
      state: text(row, "state"),
      owner: text(row, "owner"),
      integration: text(row, "integration"),
      connection: text(row, "connection"),
      template: text(row, "template"),
      clientOwner: text(row, "client_owner"),
      clientSlug: text(row, "client_slug"),
      codeVerifier: text(row, "code_verifier"),
      redirectUri: text(row, "redirect_uri"),
      ...whenPresent("resource", optionalText(row, "resource")),
      scopes
    }).pipe(Effect.mapError((cause) =>
      new StorageError({ message: "Malformed oauth_flow row", cause })
    ))
  })

export interface ToolFilter {
  readonly integration?: IntegrationSlug
  readonly owner?: OwnerTier
  readonly connection?: ConnectionName
}

export interface ConnectionFilter {
  readonly integration?: IntegrationSlug
  readonly owner?: OwnerTier
  readonly name?: ConnectionName
}

export class CatalogStore extends Context.Service<
  CatalogStore,
  {
    readonly listIntegrations: () => Effect.Effect<
      ReadonlyArray<IntegrationRecord>,
      StorageError
    >
    readonly findIntegration: (
      slug: IntegrationSlug
    ) => Effect.Effect<Option.Option<IntegrationRecord>, StorageError>
    readonly putIntegration: (record: IntegrationRecord) => Effect.Effect<void, StorageError>
    readonly renameIntegration: (
      slug: IntegrationSlug,
      name: string
    ) => Effect.Effect<void, StorageError>
    readonly removeIntegration: (slug: IntegrationSlug) => Effect.Effect<void, StorageError>

    readonly listConnections: (
      filter?: ConnectionFilter
    ) => Effect.Effect<ReadonlyArray<ConnectionRecord>, StorageError>
    readonly putConnection: (record: ConnectionRecord) => Effect.Effect<void, StorageError>
    readonly removeConnection: (reference: {
      readonly owner: OwnerTier
      readonly integration: IntegrationSlug
      readonly name: ConnectionName
    }) => Effect.Effect<void, StorageError>

    readonly findOAuthClient: (reference: {
      readonly owner: OwnerTier
      readonly slug: OAuthClientSlug
    }) => Effect.Effect<Option.Option<OAuthClientRecord>, StorageError>
    readonly putOAuthClient: (record: OAuthClientRecord) => Effect.Effect<void, StorageError>

    readonly putOAuthFlow: (record: OAuthFlowRecord) => Effect.Effect<void, StorageError>
    /** Reads a pending flow and deletes it: a state value is single-use, so
     *  taking it is what makes a replayed callback fail. */
    readonly takeOAuthFlow: (
      state: OAuthState
    ) => Effect.Effect<Option.Option<OAuthFlowRecord>, StorageError>

    /** Every captured tool a filter selects. A listing is one query. */
    readonly listTools: (
      filter?: ToolFilter
    ) => Effect.Effect<ReadonlyArray<IntegrationTool>, StorageError>
    readonly findTool: (
      address: ToolAddress
    ) => Effect.Effect<Option.Option<IntegrationTool>, StorageError>
    /** Replaces everything captured for one connection, in one transaction.
     *  Replacing rather than merging is what makes a tool the upstream dropped
     *  disappear here too. */
    readonly replaceTools: (
      connection: {
        readonly owner: OwnerTier
        readonly integration: IntegrationSlug
        readonly name: ConnectionName
      },
      tools: ReadonlyArray<IntegrationTool>
    ) => Effect.Effect<void, StorageError>

    /** The cached text of a fetched specification document. */
    readonly findSpecDocument: (
      source: string
    ) => Effect.Effect<Option.Option<string>, StorageError>
    readonly putSpecDocument: (
      source: string,
      content: string
    ) => Effect.Effect<void, StorageError>
  }
>()("@mokronos/integrations/CatalogStore") {
  static readonly layer: Layer.Layer<CatalogStore, never, Database> = Layer.effect(
    CatalogStore,
    Effect.gen(function* () {
      const database = yield* Database
      /** Writes discard the driver's empty row set: callers want completion,
       *  not rows. */
      const write = (statement: SqlStatement) =>
        Effect.asVoid(database.query(statement))

      const listIntegrations = Effect.fn("CatalogStore.listIntegrations")(function* () {
        const rows = yield* database.query({
          sql: "SELECT * FROM integration ORDER BY name COLLATE NOCASE"
        })
        return yield* Effect.forEach(rows, decodeIntegrationRow)
      })

      const findIntegration = Effect.fn("CatalogStore.findIntegration")(
        function* (slug: IntegrationSlug) {
          const rows = yield* database.query({
            sql: "SELECT * FROM integration WHERE slug = ?",
            params: [slug]
          })
          const row = rows[0]
          if (row === undefined) return Option.none()
          return Option.some(yield* decodeIntegrationRow(row))
        }
      )

      const putIntegration = Effect.fn("CatalogStore.putIntegration")(
        (record: IntegrationRecord) =>
          write({
            sql: `INSERT INTO integration
                    (slug, name, description, kind, endpoint, spec_source, spec_format,
                     base_url, display_url, auth_methods, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(slug) DO UPDATE SET
                    name = excluded.name,
                    description = excluded.description,
                    kind = excluded.kind,
                    endpoint = excluded.endpoint,
                    spec_source = excluded.spec_source,
                    spec_format = excluded.spec_format,
                    base_url = excluded.base_url,
                    display_url = excluded.display_url,
                    auth_methods = excluded.auth_methods`,
            params: [
              record.slug,
              record.name,
              record.description,
              record.kind,
              nullable(record.endpoint),
              nullable(record.specSource),
              nullable(record.specFormat),
              nullable(record.baseUrl),
              nullable(record.displayUrl),
              JSON.stringify(record.authMethods),
              record.createdAt
            ]
          })
      )

      /** Only the display name. The slug is the identity — it is in every tool
       *  address, every alias, and the key each sealed credential is stored
       *  under — so it is chosen once, at discovery, and never edited. */
      const renameIntegration = Effect.fn("CatalogStore.renameIntegration")(
        (slug: IntegrationSlug, name: string) =>
          write({
            sql: "UPDATE integration SET name = ? WHERE slug = ?",
            params: [name, slug]
          })
      )

      const removeIntegration = Effect.fn("CatalogStore.removeIntegration")(
        (slug: IntegrationSlug) =>
          database.batch([
            { sql: "DELETE FROM connection WHERE integration = ?", params: [slug] },
            { sql: "DELETE FROM integration WHERE slug = ?", params: [slug] }
          ])
      )

      const listConnections = Effect.fn("CatalogStore.listConnections")(
        function* (filter: ConnectionFilter = {}) {
          const clauses: Array<string> = []
          const params: Array<SqlValue> = []
          if (filter.integration !== undefined) {
            clauses.push("integration = ?")
            params.push(filter.integration)
          }
          if (filter.owner !== undefined) {
            clauses.push("owner = ?")
            params.push(filter.owner)
          }
          if (filter.name !== undefined) {
            clauses.push("name = ?")
            params.push(filter.name)
          }
          const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`
          const rows = yield* database.query({
            sql: `SELECT * FROM connection${where} ORDER BY integration, owner, name`,
            params
          })
          return yield* Effect.forEach(rows, decodeConnectionRow)
        }
      )

      const putConnection = Effect.fn("CatalogStore.putConnection")(
        (record: ConnectionRecord) =>
          write({
            sql: `INSERT INTO connection
                    (owner, integration, name, template, provider, identity_label,
                     description, oauth_client, oauth_client_owner, oauth_scope,
                     expires_at, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(owner, integration, name) DO UPDATE SET
                    template = excluded.template,
                    provider = excluded.provider,
                    identity_label = excluded.identity_label,
                    description = excluded.description,
                    oauth_client = excluded.oauth_client,
                    oauth_client_owner = excluded.oauth_client_owner,
                    oauth_scope = excluded.oauth_scope,
                    expires_at = excluded.expires_at`,
            params: [
              record.owner,
              record.integration,
              record.name,
              record.template,
              record.provider,
              nullable(record.identityLabel),
              nullable(record.description),
              nullable(record.oauthClient),
              nullable(record.oauthClientOwner),
              nullable(record.oauthScope),
              nullable(record.expiresAt),
              record.createdAt
            ]
          })
      )

      const removeConnection = Effect.fn("CatalogStore.removeConnection")(
        (reference: {
          readonly owner: OwnerTier
          readonly integration: IntegrationSlug
          readonly name: ConnectionName
        }) =>
          write({
            sql: "DELETE FROM connection WHERE owner = ? AND integration = ? AND name = ?",
            params: [reference.owner, reference.integration, reference.name]
          })
      )

      const findOAuthClient = Effect.fn("CatalogStore.findOAuthClient")(
        function* (reference: {
          readonly owner: OwnerTier
          readonly slug: OAuthClientSlug
        }) {
          const rows = yield* database.query({
            sql: "SELECT * FROM oauth_client WHERE owner = ? AND slug = ?",
            params: [reference.owner, reference.slug]
          })
          const row = rows[0]
          if (row === undefined) return Option.none()
          return Option.some(yield* decodeOAuthClientRow(row))
        }
      )

      const putOAuthClient = Effect.fn("CatalogStore.putOAuthClient")(
        (record: OAuthClientRecord) =>
          write({
            sql: `INSERT INTO oauth_client
                    (owner, slug, integration, client_id, authorization_url, token_url,
                     registration_endpoint, issuer, resource, scopes, token_auth_methods,
                     created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(owner, slug) DO UPDATE SET
                    integration = excluded.integration,
                    client_id = excluded.client_id,
                    authorization_url = excluded.authorization_url,
                    token_url = excluded.token_url,
                    registration_endpoint = excluded.registration_endpoint,
                    issuer = excluded.issuer,
                    resource = excluded.resource,
                    scopes = excluded.scopes,
                    token_auth_methods = excluded.token_auth_methods`,
            params: [
              record.owner,
              record.slug,
              record.integration,
              record.clientId,
              record.authorizationUrl,
              record.tokenUrl,
              nullable(record.registrationEndpoint),
              nullable(record.issuer),
              nullable(record.resource),
              JSON.stringify(record.scopes),
              JSON.stringify(record.tokenAuthMethods),
              Date.now()
            ]
          })
      )

      const putOAuthFlow = Effect.fn("CatalogStore.putOAuthFlow")(
        (record: OAuthFlowRecord) =>
          write({
            sql: `INSERT INTO oauth_flow
                    (state, owner, integration, connection, template, client_owner,
                     client_slug, code_verifier, redirect_uri, resource, scopes, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              record.state,
              record.owner,
              record.integration,
              record.connection,
              record.template,
              record.clientOwner,
              record.clientSlug,
              record.codeVerifier,
              record.redirectUri,
              nullable(record.resource),
              JSON.stringify(record.scopes),
              Date.now()
            ]
          })
      )

      const takeOAuthFlow = Effect.fn("CatalogStore.takeOAuthFlow")(
        function* (state: OAuthState) {
          const rows = yield* database.query({
            sql: "SELECT * FROM oauth_flow WHERE state = ?",
            params: [state]
          })
          const row = rows[0]
          if (row === undefined) return Option.none()
          const record = yield* decodeOAuthFlowRow(row)
          yield* write({
            sql: "DELETE FROM oauth_flow WHERE state = ?",
            params: [state]
          })
          return Option.some(record)
        }
      )

      const listTools = Effect.fn("CatalogStore.listTools")(
        function* (filter: ToolFilter = {}) {
          const clauses: Array<string> = []
          const params: Array<SqlValue> = []
          if (filter.integration !== undefined) {
            clauses.push("integration = ?")
            params.push(filter.integration)
          }
          if (filter.owner !== undefined) {
            clauses.push("owner = ?")
            params.push(filter.owner)
          }
          if (filter.connection !== undefined) {
            clauses.push("connection = ?")
            params.push(filter.connection)
          }
          const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`
          const rows = yield* database.query({
            sql: `SELECT * FROM tool${where} ORDER BY integration, owner, connection, name`,
            params
          })
          return yield* Effect.forEach(rows, decodeToolRow)
        }
      )

      const findTool = Effect.fn("CatalogStore.findTool")(function* (address: ToolAddress) {
        const rows = yield* database.query({
          sql: "SELECT * FROM tool WHERE address = ?",
          params: [address]
        })
        const row = rows[0]
        if (row === undefined) return Option.none()
        return Option.some(yield* decodeToolRow(row))
      })

      const replaceTools = Effect.fn("CatalogStore.replaceTools")((
        connection: {
          readonly owner: OwnerTier
          readonly integration: IntegrationSlug
          readonly name: ConnectionName
        },
        tools: ReadonlyArray<IntegrationTool>
      ) =>
        database.batch([
          {
            sql: "DELETE FROM tool WHERE owner = ? AND integration = ? AND connection = ?",
            params: [connection.owner, connection.integration, connection.name]
          },
          ...tools.map((tool) => ({
            sql: `INSERT INTO tool
                    (address, owner, integration, connection, name, description,
                     read_only, input_schema, output_schema, call, captured_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              tool.address,
              tool.owner,
              tool.integration,
              tool.connection,
              tool.name,
              tool.description,
              tool.readOnly ? 1 : 0,
              nullable(tool.inputSchema === undefined
                ? undefined
                : JSON.stringify(tool.inputSchema)),
              nullable(tool.outputSchema === undefined
                ? undefined
                : JSON.stringify(tool.outputSchema)),
              JSON.stringify(tool.call),
              tool.capturedAt
            ] satisfies ReadonlyArray<SqlValue>
          }))
        ])
      )

      const findSpecDocument = Effect.fn("CatalogStore.findSpecDocument")(
        function* (source: string) {
          const rows = yield* database.query({
            sql: "SELECT content FROM spec_document WHERE source = ?",
            params: [source]
          })
          const row = rows[0]
          return row === undefined ? Option.none() : Option.some(text(row, "content"))
        }
      )

      const putSpecDocument = Effect.fn("CatalogStore.putSpecDocument")(
        (source: string, content: string) =>
          write({
            sql: `INSERT INTO spec_document (source, content, fetched_at)
                  VALUES (?, ?, ?)
                  ON CONFLICT(source) DO UPDATE SET
                    content = excluded.content,
                    fetched_at = excluded.fetched_at`,
            params: [source, content, Date.now()]
          })
      )

      return {
        listIntegrations,
        findIntegration,
        putIntegration,
        renameIntegration,
        removeIntegration,
        listConnections,
        putConnection,
        removeConnection,
        findOAuthClient,
        putOAuthClient,
        putOAuthFlow,
        takeOAuthFlow,
        listTools,
        findTool,
        replaceTools,
        findSpecDocument,
        putSpecDocument
      }
    })
  )
}
