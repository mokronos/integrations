import { Clock, Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { applyIntegrationMigrations } from "@integragents/host"
import type { Encryption } from "@integragents/host"
import { defaultTenantId } from "../domain.ts"
import { applyGatewayMigrations } from "../migrate.ts"

export const GatewayStoreFailureKind = Schema.Literals(["driver", "malformed-row", "constraint"])
export type GatewayStoreFailureKind = typeof GatewayStoreFailureKind.Type

export class GatewayStoreError extends Schema.TaggedError<GatewayStoreError>()("GatewayStoreError", {
  operation: Schema.String,
  kind: GatewayStoreFailureKind,
  cause: Schema.Defect()
}) {
  override get message(): string {
    return `${this.operation} failed (${this.kind})`
  }
}

export type SqlValue = string | number | null

export interface Statement {
  readonly sql: string
  readonly args: ReadonlyArray<SqlValue>
}

type RowSchema<A> = Schema.Decoder<A>

type StoreFailure = SqlError.SqlError | Schema.SchemaError

export interface StoreQueries {
  readonly sql: SqlClient.SqlClient
  readonly encryption: Encryption
  readonly all: <A>(
    schema: RowSchema<A>,
    query: string,
    args?: ReadonlyArray<SqlValue>
  ) => Effect.Effect<Array<A>, StoreFailure>
  readonly one: <A>(
    schema: RowSchema<A>,
    query: string,
    args?: ReadonlyArray<SqlValue>
  ) => Effect.Effect<A | undefined, StoreFailure>
  readonly run: (query: string, args?: ReadonlyArray<SqlValue>) => Effect.Effect<void, SqlError.SqlError>
  /**
   * How many rows a statement touched. Asking the driver would tie us to its
   * result shape, so the statement says `RETURNING` and we count what comes
   * back — which every SQLite dialect we run on answers the same way.
   */
  readonly changed: (query: string, args?: ReadonlyArray<SqlValue>) => Effect.Effect<number, SqlError.SqlError>
  readonly count: (query: string, args?: ReadonlyArray<SqlValue>) => Effect.Effect<number, StoreFailure>
  readonly batch: (statements: ReadonlyArray<Statement>) => Effect.Effect<void, SqlError.SqlError>
  readonly seal: (text: string) => string
  /** Opens a sealed column and decodes the JSON inside it. */
  readonly openJson: <A>(schema: RowSchema<A>, sealed: string) => Effect.Effect<A, Schema.SchemaError>
}

/** The current time, read from Effect's clock so tests can govern it. */
export const now: Effect.Effect<number> = Clock.currentTimeMillis

const Total = Schema.Struct({ total: Schema.Number })

const queriesOn = (sql: SqlClient.SqlClient, encryption: Encryption): StoreQueries => {
  const raw = (query: string, args: ReadonlyArray<SqlValue> = []) => sql.unsafe<object>(query, [...args])
  const run = (query: string, args: ReadonlyArray<SqlValue> = []) => Effect.asVoid(raw(query, args))
  const one = <A>(schema: RowSchema<A>, query: string, args: ReadonlyArray<SqlValue> = []) =>
    Effect.flatMap(raw(query, args), (rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : Schema.decodeUnknownEffect(schema)(rows[0])
    )
  return {
    sql,
    encryption,
    all: (schema, query, args = []) =>
      Effect.flatMap(raw(query, args), (rows) =>
        Schema.decodeUnknownEffect(Schema.mutable(Schema.Array(schema)))(rows)
      ),
    one,
    run,
    changed: (query, args = []) => Effect.map(raw(query, args), (rows) => rows.length),
    count: (query, args = []) => Effect.map(one(Total, query, args), (row) => row?.total ?? 0),
    batch: (statements) =>
      sql.withTransaction(
        Effect.forEach(statements, (statement) => run(statement.sql, statement.args), { discard: true })
      ),
    seal: (text) => encryption.seal(text),
    openJson: (schema, sealed) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(encryption.open(sealed))
  }
}

export interface GatewayStoreOptions {
  readonly encryption: Encryption
  /** Whether opening the store brings the tables up to date. Off when the host owns migrations. */
  readonly migrate?: boolean
}

const bootstrapDefaultTenant = Effect.fn("GatewayStore.bootstrap")(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe("INSERT INTO gateway_tenant (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING", [
    defaultTenantId,
    "Default",
    yield* now
  ])
})

/** The statements every part of the store is written in, on tables brought up to date and one encryption key. */
export class StoreSql extends Context.Service<StoreSql, StoreQueries>()("@integragents/gateway-core/StoreSql") {
  static readonly layer = (
    options: GatewayStoreOptions
  ): Layer.Layer<StoreSql, GatewayStoreError, SqlClient.SqlClient> =>
    Layer.effect(
      StoreSql,
      operation(
        "open",
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          if (options.migrate !== false) {
            yield* applyIntegrationMigrations(sql)
            yield* applyGatewayMigrations(sql)
          }
          yield* bootstrapDefaultTenant(sql)
          return queriesOn(sql, options.encryption)
        })
      )
    )
}

/**
 * Which sort of failure this was. The driver classifies constraint violations
 * for us, so the distinction no longer depends on matching driver text.
 */
const failureKind = (error: StoreFailure): GatewayStoreFailureKind =>
  Schema.isSchemaError(error)
    ? "malformed-row"
    : error.reason._tag === "ConstraintError" || error.reason._tag === "UniqueViolation"
      ? "constraint"
      : "driver"

/**
 * Names what a statement was for. Every store method wraps itself, so the
 * operation appears in the span and in the error without a second mirror of
 * the interface restating it.
 */
export const operation = <Success, Requirements = never>(
  name: string,
  effect: Effect.Effect<Success, StoreFailure | GatewayStoreError, Requirements>
): Effect.Effect<Success, GatewayStoreError, Requirements> =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof GatewayStoreError
        ? cause
        : new GatewayStoreError({ operation: name, kind: failureKind(cause), cause })
    ),
    Effect.withSpan(`GatewayStore.${name}`)
  )

/** Fails as a defect when a row the statement just wrote is not there to read back. */
export const stored = <A, E>(effect: Effect.Effect<A | undefined, E>, what: string): Effect.Effect<A, E> =>
  Effect.flatMap(effect, (value) =>
    value === undefined ? Effect.die(new Error(`Failed to store ${what}`)) : Effect.succeed(value)
  )

export const placeholders = (values: ReadonlyArray<unknown>): string => values.map(() => "?").join(", ")
