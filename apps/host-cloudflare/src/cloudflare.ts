/**
 * Minimal structural view of the Cloudflare D1 binding surface.
 *
 * Deliberately not `@cloudflare/workers-types`: importing that package makes
 * its globals fight the standard-lib types the rest of this repository
 * compiles against. Everything the Worker needs from the platform fits in
 * three small shapes, which also keeps the adapters testable against plain
 * objects.
 */

/** One SQLite cell as D1 returns it over the wire. */
export type D1Cell = null | number | string | ArrayBuffer

export interface D1QueryResult {
  readonly results?: ReadonlyArray<Record<string, D1Cell>>
  readonly meta?: {
    readonly changes?: number
    readonly last_row_id?: number
  }
}

export interface D1BoundStatement {
  run(): Promise<D1QueryResult>
  all(): Promise<D1QueryResult>
  /** First row of the result, or null when the query matched nothing. */
  first(): Promise<Record<string, D1Cell> | null>
}

export interface D1Statement {
  bind(...values: ReadonlyArray<D1Cell>): D1BoundStatement
  /** Executes without binding — how parameterless statements (DDL) run. */
  run(): Promise<D1QueryResult>
}

export interface D1DatabaseLike {
  prepare(query: string): D1Statement
  /** Runs bound statements in order inside one implicit transaction. This is
   *  D1's only transaction: it has no interactive `BEGIN`, so a set of writes
   *  that has to land together has to arrive together. */
  batch(statements: ReadonlyArray<D1BoundStatement>): Promise<ReadonlyArray<D1QueryResult>>
}

/** The static-assets binding, when the Worker is deployed with one. */
export interface AssetsFetcherLike {
  fetch(request: Request): Promise<Response>
}

/** The cron event a `scheduled` invocation receives. The gateway's sweep
 *  ignores the trigger's details; the type exists so the handler signature
 *  names its input instead of leaving it unparsed. */
export interface ScheduledEventLike {
  readonly cron: string
}
