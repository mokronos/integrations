import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Reactivity } from "effect/unstable/reactivity"
import { SqlClient } from "effect/unstable/sql"
import { LibsqlClient } from "@effect/sql-libsql"
import { CatalogStore } from "./catalog/store.ts"
import { CredentialStore } from "./storage/credentials.ts"
import { BlobStore } from "./storage/blobs.ts"
import { Database } from "./storage/database.ts"
import type { Encryption } from "./storage/encryption.ts"
import { applyMigrations } from "./storage/migrate.ts"
import { integrationMigrations } from "./storage/migrations.gen.ts"
import { Integrations } from "./integrations.ts"
import { McpClient } from "./mcp/client.ts"
import { OAuthFlows } from "./oauth/flows.ts"
import { OpenApiInvoker } from "./openapi/invoke.ts"
import { SpecCache } from "./openapi/cache.ts"

export const unavailableHttpClientLayer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("Unexpected HTTP request"))
)

const clientsLayer: Layer.Layer<
  McpClient | OpenApiInvoker,
  never,
  HttpClient.HttpClient | BlobStore
> = Layer.mergeAll(McpClient.layer, OpenApiInvoker.layer)

const capabilitiesLayer: Layer.Layer<
  Integrations | OAuthFlows | SpecCache | CatalogStore,
  never,
  Database | CredentialStore | HttpClient.HttpClient | McpClient | OpenApiInvoker
> = Integrations.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(SpecCache.layer, OAuthFlows.layer)),
  Layer.provideMerge(CatalogStore.layer)
)

export type IntegrationServices =
  | Integrations
  | McpClient
  | OAuthFlows
  | OpenApiInvoker
  | SpecCache
  | CatalogStore
  | BlobStore

/** The migration set the catalog's tables come from; stamped in `integration_migration`. */
export const integrationMigrationSet = { ledger: "integration_migration", migrations: integrationMigrations } as const

export const applyIntegrationMigrations = (sql: SqlClient.SqlClient) =>
  applyMigrations(sql, integrationMigrationSet)

export interface IntegrationLayerOptions {
  readonly encryption: Encryption
  readonly blobs: Layer.Layer<BlobStore>
}

/**
 * Every integration service on the host's `SqlClient`. The tables are expected
 * to exist; whoever owns the database applies `integrationMigrationSet`.
 */
export const integrationLayer = (
  options: IntegrationLayerOptions
): Layer.Layer<IntegrationServices, never, SqlClient.SqlClient | HttpClient.HttpClient> =>
  capabilitiesLayer.pipe(
    Layer.provideMerge(clientsLayer),
    Layer.provideMerge(options.blobs),
    Layer.provide(Layer.mergeAll(Database.layer, CredentialStore.sqlLayer(options.encryption)))
  )

/**
 * A throwaway SQLite file with the catalog's tables, removed with the scope.
 * A file rather than `:memory:`: libsql hands its connection to each
 * transaction and opens a fresh one afterwards, which for a memory database
 * is an empty one.
 */
export const temporarySqlLayer: Layer.Layer<SqlClient.SqlClient> = Layer.unwrap(
  Effect.map(
    Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), "integrations-sql-"))),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
    ),
    (directory) => LibsqlClient.layer({ url: `file:${path.join(directory, "integrations.sqlite")}` })
  )
).pipe(
  Layer.tap((context) => Effect.orDie(applyIntegrationMigrations(Context.get(context, SqlClient.SqlClient)))),
  Layer.provide(Reactivity.layer)
)

export const stubbedLayer = (
  clients: Layer.Layer<McpClient | OpenApiInvoker>
): Layer.Layer<
  | Integrations
  | OAuthFlows
  | SpecCache
  | CatalogStore
  | McpClient
  | OpenApiInvoker
  | Database
  | CredentialStore
> =>
  capabilitiesLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(clients, unavailableHttpClientLayer)),
    Layer.provideMerge(Layer.mergeAll(Database.layer.pipe(Layer.provide(temporarySqlLayer)), CredentialStore.memoryLayer))
  )
