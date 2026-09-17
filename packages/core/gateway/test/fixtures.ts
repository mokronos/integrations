import { randomBytes } from "node:crypto"
import path from "node:path"
import { Context, Effect, FileSystem, Layer, Scope } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { temporaryDirectory } from "@integrations/contracts/test-fixtures"
import { createEncryption, createGatewayStore, libsqlLayer } from "../src/index.ts"
import type { GatewayStore } from "../src/index.ts"

export { temporaryDirectory, testServices } from "@integrations/contracts/test-fixtures"

export const testEncryption = createEncryption(randomBytes(32))

/** A SQLite file in the directory, closed when the test's scope ends. */
export const openDatabase = (
  directory: string
): Effect.Effect<SqlClient.SqlClient, never, Scope.Scope> =>
  Effect.map(
    Layer.build(libsqlLayer(path.join(directory, "gateway.sqlite"))),
    (context) => Context.get(context, SqlClient.SqlClient)
  )

export const openStore = (
  directory: string
): Effect.Effect<GatewayStore, never, Scope.Scope> =>
  Effect.flatMap(openDatabase(directory), storeOn)

/** A store on a database already open, as a host reopening its own tables. */
export const storeOn = (sql: SqlClient.SqlClient): Effect.Effect<GatewayStore> =>
  Effect.orDie(createGatewayStore({ encryption: testEncryption }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql)
  ))

/** A store on its own database, closed when the test's scope ends. */
export const gatewayStore = (
  prefix = "gateway-"
): Effect.Effect<GatewayStore, never, FileSystem.FileSystem | Scope.Scope> =>
  Effect.flatMap(temporaryDirectory(prefix), openStore)
