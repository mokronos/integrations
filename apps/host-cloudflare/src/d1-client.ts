import type { InArgs, InStatement, InValue, ResultSet, Row, TransactionMode, Value } from "@libsql/client"
import { Schema } from "effect"
import type { D1Cell, D1DatabaseLike, D1QueryResult } from "./cloudflare.ts"

/** What a D1 binding accepts as a parameter. */
const Bindable = Schema.Union([
  Schema.Null,
  Schema.Number,
  Schema.String,
  Schema.instanceOf(Uint8Array)
])
const decodeBindable = Schema.decodeUnknownSync(Bindable)

/** What SQLite columns hold once out of the engine; libsql's row value type,
 *  minus the input-only forms (boolean, bigint, Date) that a SELECT never
 *  returns. */
const Cell = Schema.Union([
  Schema.Null,
  Schema.Number,
  Schema.String,
  Schema.instanceOf(ArrayBuffer),
  Schema.instanceOf(Uint8Array)
])
const decodeCell = Schema.decodeUnknownSync(Cell)

type BindValue = null | number | string | ArrayBuffer

const toArrayBuffer = (view: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(view.byteLength)
  new Uint8Array(buffer).set(view)
  return buffer
}

/** libsql's statement union is `string | { sql, args }` — its own wire shape,
 *  not a domain value, so there is no schema to parse it into. The predicate
 *  names the discrimination once; both branches below stay typed. */
const isRawSql = (statement: InStatement): statement is string =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  typeof statement === "string"

/** Maps one bound argument from libsql's permissive input set onto D1's
 *  narrower one. Blobs copy into an ArrayBuffer because D1 speaks that
 *  dialect. Anything outside both engines' contract fails loudly rather than
 *  mutating silently — the gateway store binds only strings, numbers, and
 *  nulls. */
const toBindValue = (value: InValue): BindValue => {
  const decoded = decodeBindable(value)
  return decoded instanceof Uint8Array ? toArrayBuffer(decoded) : decoded
}

/** Narrows one returned cell to a SQLite value. */
const toCell = (cell: D1Cell): Value => {
  const decoded = decodeCell(cell)
  return decoded instanceof Uint8Array ? toArrayBuffer(decoded) : decoded
}

/** Builds a libsql Row (numeric indexes, length, named columns) from D1's
 *  plain object. The store picks fields by name; the numeric view exists so
 *  the object satisfies the interface rather than because anyone reads it. */
const toRow = (record: Record<string, D1Cell>): Row => {
  const names = Object.keys(record)
  const row: Row = { length: names.length }
  for (const [index, name] of names.entries()) {
    const value = toCell(record[name] ?? null)
    row[index] = value
    row[name] = value
  }
  return row
}

/** Assembles a libsql ResultSet, including the JSON view its interface
 *  promises. D1 rows are plain objects already, so the JSON form is free. */
const toResultSet = (
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<Row>,
  meta: { readonly changes?: number; readonly last_row_id?: number }
): ResultSet => {
  const jsonView = {
    columns: [...columns],
    columnTypes: columns.map(() => ""),
    rows: [...rows],
    rowsAffected: Number(meta.changes ?? 0),
    lastInsertRowid:
      meta.last_row_id === undefined || meta.last_row_id === 0
        ? undefined
        : BigInt(Math.trunc(meta.last_row_id))
  }
  return { ...jsonView, toJSON: () => jsonView }
}

/** One D1 answer as a libsql ResultSet. Column names come from the first row;
 *  the store reads by name only, and a write returns no rows to name. */
const toD1ResultSet = (result: D1QueryResult): ResultSet => {
  const rows = (result.results ?? []).map(toRow)
  const columns = Object.keys(rows[0] ?? {}).filter((name) => Number.isNaN(Number(name)))
  return toResultSet(columns, rows, result.meta ?? {})
}

/**
 * The slice of `@libsql/client`'s Client that the gateway store speaks,
 * carried by a Cloudflare D1 binding instead of a local file.
 *
 * `execute` serves the store, which runs single statements exclusively,
 * generates ids application-side, and consumes rows by name plus
 * `rowsAffected`. `batch` serves the migration runner, which needs a set of
 * statements and the row that records them applied to land together or not at
 * all; D1's own batch is that transaction. The rest of the multi-statement
 * surface throws rather than pretending. Pragmas pass through except
 * `journal_mode`, which is file-engine business: D1 has no journal to tune and
 * enforces foreign keys unconditionally.
 */
export class D1Client {
  /** Identifies the engine the way libsql clients report their URL scheme. */
  readonly protocol = "d1"
  readonly #database: D1DatabaseLike
  #closed = false

  constructor(database: D1DatabaseLike) {
    this.#database = database
  }

  get closed(): boolean {
    return this.#closed
  }

  /** The file client retries transient connection losses; a binding call has
   *  no connection to re-establish, so there is nothing to do. */
  reconnect(): void {}

  async execute(statement: InStatement, argsOverride?: InArgs): Promise<ResultSet> {
    const sql = isRawSql(statement) ? statement : statement.sql
    if (/^\s*PRAGMA\s+journal_mode/im.test(sql)) {
      return toResultSet([], [], {})
    }
    const prepared = this.#prepare(statement, argsOverride)
    let result: D1QueryResult
    try {
      result = await prepared.statement.all()
    } catch (cause) {
      // D1's own error names neither the statement nor the arity mismatch;
      // both travel with the rethrow instead.
      throw new Error(`D1 rejected: ${sql} (bindings: ${prepared.bindings})`, { cause })
    }
    return toD1ResultSet(result)
  }

  /** Runs every statement inside D1's implicit batch transaction: either all of
   *  them are applied or none are. The migration runner sends a migration and
   *  the row that stamps it as one batch for exactly this reason. */
  async batch(statements: Array<InStatement>): Promise<Array<ResultSet>> {
    const prepared = statements.map((statement) => this.#prepare(statement))
    let results: ReadonlyArray<D1QueryResult>
    try {
      results = await this.#database.batch(prepared.map((entry) => entry.statement))
    } catch (cause) {
      throw new Error(`D1 rejected a batch of ${statements.length} statement(s)`, { cause })
    }
    return results.map(toD1ResultSet)
  }

  /** Binds one libsql statement onto D1. libsql exposes two shapes —
   *  `execute(stmt)` and the `execute(sql, args)` convenience overload — and
   *  the store uses both; dropping the second argument would silently strip
   *  every string-form call's bindings (D1 answers with "wrong number of
   *  parameter bindings"), so both arrive here. */
  #prepare(statement: InStatement, argsOverride?: InArgs) {
    const sql = isRawSql(statement) ? statement : statement.sql
    const rawArgs = isRawSql(statement)
      ? argsOverride ?? []
      : statement.args ?? []
    if (!Array.isArray(rawArgs)) {
      throw new Error("The D1 adapter binds positional arguments only; the store never sends named ones")
    }
    const args = rawArgs.map(toBindValue)
    return { statement: this.#database.prepare(sql).bind(...args), bindings: args.length }
  }

  async executeMultiple(_sql: string): Promise<void> {
    throw new Error("The D1 adapter does not implement executeMultiple")
  }

  async migrate(_statements: Array<InStatement>): Promise<Array<ResultSet>> {
    throw new Error("The D1 adapter does not implement migrate")
  }

  async transaction(_mode?: TransactionMode): Promise<never> {
    throw new Error("The D1 adapter does not implement transactions; D1 has no interactive transactions")
  }

  async sync(): Promise<never> {
    throw new Error("The D1 adapter has no embedded replica to sync")
  }

  close(): void {
    this.#closed = true
  }
}
