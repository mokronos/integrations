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
  first(): Promise<Record<string, D1Cell> | null>
}

export interface D1Statement {
  bind(...values: ReadonlyArray<D1Cell>): D1BoundStatement
  run(): Promise<D1QueryResult>
}

export interface D1DatabaseLike {
  prepare(query: string): D1Statement
  batch(statements: ReadonlyArray<D1BoundStatement>): Promise<ReadonlyArray<D1QueryResult>>
}

export interface AssetsFetcherLike {
  fetch(request: Request): Promise<Response>
}

export interface ScheduledEventLike {
  readonly cron: string
}
