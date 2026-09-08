import type { InArgs, InStatement, InValue, ResultSet, Row, TransactionMode, Value } from "@libsql/client"
import { Schema } from "effect"
import type { D1Cell, D1DatabaseLike, D1QueryResult } from "./cloudflare.ts"

const Bindable = Schema.Union([
  Schema.Null,
  Schema.Number,
  Schema.String,
  Schema.instanceOf(Uint8Array)
])
const decodeBindable = Schema.decodeUnknownSync(Bindable)

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

const isRawSql = (statement: InStatement): statement is string =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  typeof statement === "string"

const toBindValue = (value: InValue): BindValue => {
  const decoded = decodeBindable(value)
  return decoded instanceof Uint8Array ? toArrayBuffer(decoded) : decoded
}

const toCell = (cell: D1Cell): Value => {
  const decoded = decodeCell(cell)
  return decoded instanceof Uint8Array ? toArrayBuffer(decoded) : decoded
}

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

const toD1ResultSet = (result: D1QueryResult): ResultSet => {
  const rows = (result.results ?? []).map(toRow)
  const columns = Object.keys(rows[0] ?? {}).filter((name) => Number.isNaN(Number(name)))
  return toResultSet(columns, rows, result.meta ?? {})
}

export class D1Client {
  readonly protocol = "d1"
  readonly #database: D1DatabaseLike
  #closed = false

  constructor(database: D1DatabaseLike) {
    this.#database = database
  }

  get closed(): boolean {
    return this.#closed
  }

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
      throw new Error(`D1 rejected: ${sql} (bindings: ${prepared.bindings})`, { cause })
    }
    return toD1ResultSet(result)
  }

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
