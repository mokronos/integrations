import { Context, Effect, Layer, Predicate, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql"
import { StorageError } from "../errors.ts"

export const SqlValue = Schema.Union([Schema.String, Schema.Number, Schema.Null])
export type SqlValue = typeof SqlValue.Type

export const SqlRow = Schema.Record(Schema.String, SqlValue)
export type SqlRow = typeof SqlRow.Type

export interface SqlStatement {
  readonly sql: string
  readonly params?: ReadonlyArray<SqlValue>
}

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(SqlRow))

export class Database extends Context.Service<
  Database,
  {
    readonly query: (statement: SqlStatement) => Effect.Effect<ReadonlyArray<SqlRow>, StorageError>
    readonly batch: (statements: ReadonlyArray<SqlStatement>) => Effect.Effect<void, StorageError>
  }
>()("@mokronos/integrations-host/Database") {
  /** The catalog's tables on whatever `SqlClient` the host provides. */
  static readonly layer: Layer.Layer<Database, never, SqlClient.SqlClient> = Layer.effect(
    Database,
    Effect.map(SqlClient.SqlClient, sqlDatabase)
  )
}

const Cell = Schema.Union([Schema.String, Schema.Number, Schema.Null, Schema.BigInt, Schema.Boolean, Schema.Uint8Array])

const cell = (value: typeof Cell.Type): SqlValue => {
  if (Predicate.isString(value) || Predicate.isNumber(value)) return value
  if (Predicate.isBigInt(value)) return Number(value)
  if (Predicate.isBoolean(value)) return value ? 1 : 0
  if (Predicate.isNull(value)) return null
  return new TextDecoder().decode(value)
}

const decodeCells = Schema.decodeUnknownEffect(Schema.Array(Schema.Record(Schema.String, Cell)))

const firstLine = (sql: string): string => sql.trim().split("\n")[0] ?? sql

const storageFailure = (sql: string) => (cause: SqlError.SqlError | Schema.SchemaError): StorageError =>
  new StorageError({ message: `Statement failed: ${firstLine(sql)} (${cause.message})`, cause })

function sqlDatabase(sql: SqlClient.SqlClient): Database["Service"] {
  const query = Effect.fn("Database.query")((statement: SqlStatement) =>
    sql.unsafe(statement.sql, [...(statement.params ?? [])]).pipe(
      Effect.flatMap(decodeCells),
      Effect.map((rows) =>
        rows.map((row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, cell(value)])))
      ),
      Effect.flatMap(decodeRows),
      Effect.mapError(storageFailure(statement.sql))
    )
  )

  const batch = Effect.fn("Database.batch")((statements: ReadonlyArray<SqlStatement>) =>
    sql.withTransaction(Effect.forEach(statements, query, { discard: true })).pipe(
      Effect.mapError((cause) =>
        cause instanceof StorageError ? cause : storageFailure(statements[0]?.sql ?? "batch")(cause)
      )
    )
  )

  return { query, batch }
}
