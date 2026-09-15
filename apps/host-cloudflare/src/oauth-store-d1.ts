import { OAuthSessionError, OAuthSessionRequest } from "@integrations/gateway-core"
import type { OAuthSession, OAuthSessionStore } from "@integrations/gateway-core"
import { OAuthSessionState, whenPresent } from "@integrations/contracts"
import { Effect, Schema } from "effect"
import type { D1DatabaseLike } from "./cloudflare.ts"

const sessionTtlMs = 24 * 60 * 60 * 1000

const SessionRow = Schema.Struct({
  id: Schema.String,
  integration: Schema.String,
  connection_name: Schema.String,
  status_json: Schema.String,
  request_json: Schema.String
})

const StoredSessionRow = Schema.Struct({
  ...SessionRow.fields,
  created_at: Schema.Number
})

const StateOwnerRow = Schema.Struct({
  session_id: Schema.String,
  created_at: Schema.Number
})

const decodeSessionStateJson = Schema.decodeUnknownSync(Schema.fromJsonString(OAuthSessionState))
const decodeSessionRequestJson = Schema.decodeUnknownSync(Schema.fromJsonString(OAuthSessionRequest))
const encodeSessionRequestJson = Schema.encodeSync(Schema.fromJsonString(OAuthSessionRequest))
const decodeStoredSessionRow = Schema.decodeUnknownSync(StoredSessionRow)
const decodeStateOwnerRow = Schema.decodeUnknownSync(StateOwnerRow)

const ddl = [
  `CREATE TABLE IF NOT EXISTS gateway_oauth_session (
     id TEXT PRIMARY KEY,
     integration TEXT NOT NULL,
     connection_name TEXT NOT NULL,
     status_json TEXT NOT NULL,
     request_json TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS gateway_oauth_state (
     state TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`
]

export class D1OAuthSessionStore implements OAuthSessionStore {
  readonly #database: D1DatabaseLike
  #ready: Promise<void> | undefined

  constructor(database: D1DatabaseLike) {
    this.#database = database
  }

  ensureReady(): Promise<void> {
    this.#ready ??= (async () => {
      for (const statement of ddl) {
        await this.#database.prepare(statement).run()
      }
    })()
    return this.#ready
  }

  #operation<A>(operation: string, run: () => Promise<A>): Effect.Effect<A, OAuthSessionError> {
    return Effect.tryPromise({
      try: run,
      catch: (cause) => new OAuthSessionError({ operation, cause })
    }).pipe(Effect.withSpan(`OAuthSessionStore.${operation}`))
  }

  readonly put = (session: OAuthSession): Effect.Effect<void, OAuthSessionError> =>
    this.#operation("put", async () => {
      await this.ensureReady()
      const statusJson = JSON.stringify(session.state)
      await this.#database
        .prepare(
          `INSERT INTO gateway_oauth_session (id, integration, connection_name, status_json, request_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             integration = excluded.integration,
             connection_name = excluded.connection_name,
             status_json = excluded.status_json,
             request_json = excluded.request_json`
        )
        .bind(
          session.id,
          session.integration,
          session.connection,
          statusJson,
          encodeSessionRequestJson(session.request),
          Date.now()
        )
        .run()
    })

  readonly get = (id: string): Effect.Effect<OAuthSession | undefined, OAuthSessionError> =>
    this.#operation("get", async () => {
      await this.ensureReady()
      const result = await this.#database
        .prepare(
          `SELECT id, integration, connection_name, status_json, request_json, created_at
           FROM gateway_oauth_session WHERE id = ?`
        )
        .bind(id)
        .first()
      if (result === null) return undefined
      const row = decodeStoredSessionRow(result)
      if (Date.now() - row.created_at > sessionTtlMs) return undefined
      const request = decodeSessionRequestJson(row.request_json)
      return {
        id: row.id,
        integration: row.integration,
        connection: row.connection_name,
        request,
        ...whenPresent("bindingTenant", request.bindingTenant),
        state: decodeSessionStateJson(row.status_json)
      }
    })

  readonly putState = (
    state: string,
    sessionId: string
  ): Effect.Effect<void, OAuthSessionError> => this.#operation("putState", async () => {
    await this.ensureReady()
    await this.#database
      .prepare(
        `INSERT INTO gateway_oauth_state (state, session_id, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT (state) DO UPDATE SET session_id = excluded.session_id`
      )
      .bind(state, sessionId, Date.now())
      .run()
  })

  readonly findState = (state: string): Effect.Effect<string | undefined, OAuthSessionError> =>
    this.#operation("findState", async () => {
      await this.ensureReady()
      const row = await this.#database
        .prepare("SELECT session_id, created_at FROM gateway_oauth_state WHERE state = ?")
        .bind(state)
        .first()
      if (row === null) return undefined
      const owner = decodeStateOwnerRow(row)
      if (Date.now() - owner.created_at > sessionTtlMs) return undefined
      return owner.session_id
    })

  readonly deleteState = (state: string): Effect.Effect<void, OAuthSessionError> =>
    this.#operation("deleteState", async () => {
      await this.ensureReady()
      await this.#database
        .prepare("DELETE FROM gateway_oauth_state WHERE state = ?")
        .bind(state)
        .run()
    })
}
