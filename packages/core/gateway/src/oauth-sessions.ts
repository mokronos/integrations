import { AuthMethod, OAuthSessionState, SubjectId, TenantId, userOwner, whenPresent } from "@integragents/contracts"

import { Clock, Context, Deferred, Effect, Exit, Schema, Scope } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { webCrypto } from "@integragents/contracts"
import { completeOAuthFlow } from "@integragents/host"
import { OAuthFlowError, startRemoteAuthorization } from "./oauth.ts"
import type { LocalAuthorizer, OAuthOperations } from "./oauth.ts"

/**
 * Everything needed to run the authorization again, minus the OAuth client
 * credentials: a secret belongs in the credential store, not in a session.
 */
export const OAuthSessionRequest = Schema.Struct({
  integration: Schema.String,
  connection: Schema.String,
  authMethod: AuthMethod,
  timeoutMs: Schema.optional(Schema.Number),
  bindingTenant: Schema.optional(TenantId),
  /** The person this flow connects for. Set at start, so a leaked URL can only ever finish their connection. */
  subject: Schema.optional(SubjectId)
})
export type OAuthSessionRequest = typeof OAuthSessionRequest.Type

export type OAuthSession = {
  readonly id: string
  readonly integration: string
  readonly connection: string
  readonly bindingTenant?: TenantId
  readonly subject?: SubjectId
  readonly request: OAuthSessionRequest
  readonly state: OAuthSessionState
}

export class OAuthSessionError extends Schema.TaggedError<OAuthSessionError>()(
  "OAuthSessionError",
  {
    operation: Schema.String,
    cause: Schema.Defect()
  }
) {
  override get message(): string {
    return `OAuth ${this.operation} failed: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`
  }
}

export interface OAuthSessionStore {
  put(session: OAuthSession): Effect.Effect<void, OAuthSessionError>
  get(id: string): Effect.Effect<OAuthSession | undefined, OAuthSessionError>
  putState(state: string, sessionId: string): Effect.Effect<void, OAuthSessionError>
  findState(state: string): Effect.Effect<string | undefined, OAuthSessionError>
  deleteState(state: string): Effect.Effect<void, OAuthSessionError>
}

const sessionTtlMs = 24 * 60 * 60 * 1000

const StoredSessionRow = Schema.Struct({
  id: Schema.String,
  integration: Schema.String,
  connection_name: Schema.String,
  status_json: Schema.fromJsonString(OAuthSessionState),
  request_json: Schema.fromJsonString(OAuthSessionRequest),
  created_at: Schema.Number
})
const decodeStoredSessions = Schema.decodeUnknownEffect(Schema.Array(StoredSessionRow))
const StateOwnerRow = Schema.Struct({ session_id: Schema.String, created_at: Schema.Number })
const decodeStateOwners = Schema.decodeUnknownEffect(Schema.Array(StateOwnerRow))
const encodeRequestJson = Schema.encodeSync(Schema.fromJsonString(OAuthSessionRequest))

/**
 * Sessions in the gateway's own tables, so a flow started on one instance
 * completes on another and survives a restart.
 */
export const sqlOAuthSessionStore = (sql: SqlClient.SqlClient): OAuthSessionStore => {
  const operation = <A, E>(name: string, effect: Effect.Effect<A, E>): Effect.Effect<A, OAuthSessionError> =>
    effect.pipe(
      Effect.mapError((cause) => new OAuthSessionError({ operation: name, cause })),
      Effect.withSpan(`OAuthSessionStore.${name}`)
    )

  return {
    put: (session) => operation("put", Effect.gen(function*() {
      yield* sql.unsafe(
        `INSERT INTO gateway_oauth_session (id, integration, connection_name, status_json, request_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           integration = excluded.integration,
           connection_name = excluded.connection_name,
           status_json = excluded.status_json,
           request_json = excluded.request_json`,
        [
          session.id,
          session.integration,
          session.connection,
          JSON.stringify(session.state),
          encodeRequestJson(session.request),
          yield* Clock.currentTimeMillis
        ]
      )
    })),

    get: (id) => operation("get", Effect.gen(function*() {
      const rows = yield* decodeStoredSessions(yield* sql.unsafe(
        `SELECT id, integration, connection_name, status_json, request_json, created_at
         FROM gateway_oauth_session WHERE id = ?`,
        [id]
      ))
      const row = rows[0]
      if (row === undefined) return undefined
      if ((yield* Clock.currentTimeMillis) - row.created_at > sessionTtlMs) return undefined
      return {
        id: row.id,
        integration: row.integration,
        connection: row.connection_name,
        request: row.request_json,
        ...whenPresent("bindingTenant", row.request_json.bindingTenant),
        ...whenPresent("subject", row.request_json.subject),
        state: row.status_json
      } satisfies OAuthSession
    })),

    putState: (state, sessionId) => operation("putState", Effect.gen(function*() {
      yield* sql.unsafe(
        `INSERT INTO gateway_oauth_state (state, session_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT (state) DO UPDATE SET session_id = excluded.session_id`,
        [state, sessionId, yield* Clock.currentTimeMillis]
      )
    })),

    findState: (state) => operation("findState", Effect.gen(function*() {
      const rows = yield* decodeStateOwners(yield* sql.unsafe(
        "SELECT session_id, created_at FROM gateway_oauth_state WHERE state = ?",
        [state]
      ))
      const owner = rows[0]
      if (owner === undefined) return undefined
      if ((yield* Clock.currentTimeMillis) - owner.created_at > sessionTtlMs) return undefined
      return owner.session_id
    })),

    deleteState: (state) => operation("deleteState",
      Effect.asVoid(sql.unsafe("DELETE FROM gateway_oauth_state WHERE state = ?", [state])))
  }
}

export interface OAuthSessions {
  start(
    input: OAuthSessionRequest & {
      readonly clientId?: string
      readonly clientSecret?: string
    }
  ): Effect.Effect<OAuthSession, OAuthSessionError | OAuthFlowError>
  provideClient(
    id: string,
    client: { readonly clientId: string; readonly clientSecret?: string }
  ): Effect.Effect<OAuthSession | undefined, OAuthSessionError | OAuthFlowError>
  get(id: string): Effect.Effect<OAuthSession | undefined, OAuthSessionError>
  completeByState(
    state: string,
    input: { readonly code: string; readonly callbackDomain?: string | null }
  ): Effect.Effect<OAuthSession | undefined, OAuthSessionError>
  stop(): Effect.Effect<void>
}

export interface OAuthSessionsOptions {
  readonly publicUrl?: string
  readonly publicUrlOf?: () => string | undefined
  /** Completes flows on a host-owned listener when no public URL is configured. */
  readonly authorizeLocally?: LocalAuthorizer
  readonly store?: OAuthSessionStore
  readonly onConnected?: (session: OAuthSession) => Effect.Effect<void, OAuthSessionError>
}

const setupUrl = (publicUrl: string, session: string): string => {
  const url = new URL("/integrations", publicUrl)
  url.searchParams.set("setup", session)
  return url.toString()
}

const inMemoryStore = (): OAuthSessionStore & { clear(): void } => {
  const sessions = new Map<string, OAuthSession>()
  const flowsByState = new Map<string, string>()
  return {
    put: (session) => Effect.sync(() => {
      sessions.set(session.id, session)
    }),
    get: (id) => Effect.sync(() => sessions.get(id)),
    putState: (state, sessionId) => Effect.sync(() => {
      flowsByState.set(state, sessionId)
    }),
    findState: (state) => Effect.sync(() => flowsByState.get(state)),
    deleteState: (state) => Effect.sync(() => {
      flowsByState.delete(state)
    }),
    clear: () => {
      sessions.clear()
      flowsByState.clear()
    }
  }
}

export const createOAuthSessions = (
  host: Context.Context<OAuthOperations>,
  options: OAuthSessionsOptions = {}
): OAuthSessions => {
  const memory = inMemoryStore()
  const store: OAuthSessionStore = options.store ?? memory
  let stopped = false

  let flowScopeCell: Scope.Closeable | undefined
  const flowScope = Effect.suspend(() =>
    flowScopeCell === undefined
      ? Effect.map(Scope.make(), (made) => {
        flowScopeCell = made
        return made
      })
      : Effect.succeed(flowScopeCell)
  )

  const finish = Effect.fn("OAuthSession.finish")(function*(
    id: string,
    state: OAuthSessionState
  ): Effect.fn.Return<void, OAuthSessionError> {
    const existing = yield* store.get(id)
    if (existing === undefined) return
    yield* store.put({ ...existing, state })
  })

  const authorize = Effect.fn("OAuthSession.authorize")(function*(
    id: string,
    input: OAuthSessionRequest,
    client: { readonly clientId?: string; readonly clientSecret?: string }
  ): Effect.fn.Return<OAuthSession, OAuthSessionError | OAuthFlowError> {
    const publicUrl = options.publicUrlOf?.() ?? options.publicUrl
    const base = {
      id,
      integration: input.integration,
      connection: input.connection,
      request: input,
      ...whenPresent("bindingTenant", input.bindingTenant),
      ...whenPresent("subject", input.subject)
    }
    const owner = input.subject === undefined ? {} : { owner: userOwner(input.subject) }

    if (publicUrl !== undefined) {
      const started = yield* Effect.result(
        startRemoteAuthorization({
          integration: input.integration,
          connection: input.connection,
          ...owner,
          authMethod: input.authMethod,
          publicUrl,
          ...whenPresent("clientId", client.clientId),
          ...whenPresent("clientSecret", client.clientSecret),
          ...whenPresent("timeoutMs", input.timeoutMs)
        }).pipe(Effect.provide(host))
      )
      if (started._tag === "Failure") {
        if (started.failure.stage !== "client-required") return yield* started.failure
        const waiting: OAuthSession = {
          ...base,
          state: {
            status: "needs-client",
            setupUrl: setupUrl(publicUrl, id),
            guidance: started.failure.detail
          }
        }
        yield* store.put(waiting)
        return waiting
      }
      const flow = started.success
      if (flow.status === "connected") {
        const connected: OAuthSession = {
          ...base,
          state: { status: "connected", connection: flow.connection }
        }
        yield* store.put(connected)
        if (options.onConnected !== undefined) {
          yield* options.onConnected(connected)
        }
        return connected
      }
      yield* store.putState(flow.state, id)
      const pending: OAuthSession = {
        ...base,
        state: { status: "pending", authorizationUrl: flow.authorizationUrl }
      }
      yield* store.put(pending)
      return pending
    }

    const authorizeLocally = options.authorizeLocally
    if (authorizeLocally === undefined) {
      return yield* new OAuthSessionError({
        operation: "start",
        cause: new Error("OAuth needs a public URL for the provider to redirect to, and none is configured")
      })
    }
    const parent = yield* flowScope
    const announced = yield* Deferred.make<string>()

    yield* authorizeLocally({
      integration: input.integration,
      connection: input.connection,
      ...owner,
      authMethod: input.authMethod,
      ...whenPresent("clientId", client.clientId),
      ...whenPresent("clientSecret", client.clientSecret),
      ...whenPresent("timeoutMs", input.timeoutMs),
      onAuthorizationUrl: (url) => {
        Deferred.doneUnsafe(announced, Effect.succeed(url))
      }
    }).pipe(
      Effect.provide(host),
      Effect.matchEffect({
        onSuccess: (connection) =>
          Effect.gen(function*() {
            yield* finish(id, { status: "connected", connection })
            const session = yield* store.get(id)
            if (session !== undefined && options.onConnected !== undefined) {
              yield* options.onConnected(session)
            }
          }),
        onFailure: (failure) => finish(id, { status: "failed", message: failure.message })
      }),
      Effect.catch((failure) =>
        Effect.logError(`OAuth session ${id} could not be settled: ${failure.message}`).pipe(
          Effect.annotateLogs({ session: id, operation: "OAuthSession.settle" })
        )),
      Effect.ensuring(Effect.sync(() => {
        Deferred.doneUnsafe(announced, Effect.succeed(""))
      })),
      Effect.scoped,
      Effect.forkIn(parent)
    )

    const authorizationUrl = yield* Deferred.await(announced)
    const session = (yield* store.get(id)) ?? {
      ...base,
      state: { status: "pending" as const, authorizationUrl }
    }
    yield* store.put(session)
    return session
  })

  return {
    start: Effect.fn("OAuthSession.start")(function*(input) {
      if (stopped) {
        return yield* new OAuthSessionError({
          operation: "start",
          cause: new Error("The gateway is shutting down")
        })
      }
      const id = yield* Effect.orDie(webCrypto.randomUUIDv4)
      return yield* authorize(id, {
        integration: input.integration,
        connection: input.connection,
        authMethod: input.authMethod,
        ...whenPresent("timeoutMs", input.timeoutMs),
        ...whenPresent("bindingTenant", input.bindingTenant),
        ...whenPresent("subject", input.subject)
      }, input)
    }),

    provideClient: Effect.fn("OAuthSession.provideClient")(function*(id, client) {
      if (stopped) {
        return yield* new OAuthSessionError({
          operation: "provideClient",
          cause: new Error("The gateway is shutting down")
        })
      }
      const session = yield* store.get(id)
      if (session === undefined || session.state.status !== "needs-client") return undefined
      return yield* authorize(id, session.request, client)
    }),

    get: (id) => store.get(id),

    completeByState: Effect.fn("OAuthSession.completeByState")(function*(state, input) {
      if (stopped) return undefined
      const id = yield* store.findState(state)
      if (id === undefined) return undefined
      yield* store.deleteState(state)
      const session = yield* store.get(id)
      if (session === undefined || session.state.status !== "pending") return undefined
      const result = yield* Effect.result(
        completeOAuthFlow({ state, code: input.code }).pipe(Effect.provide(host))
      )
      if (result._tag === "Success") {
        yield* finish(id, { status: "connected", connection: result.success })
        const completed = yield* store.get(id)
        if (completed !== undefined && options.onConnected !== undefined) {
          yield* options.onConnected(completed)
        }
      } else {
        yield* finish(id, { status: "failed", message: result.failure.message })
      }
      return yield* store.get(id)
    }),

    stop: () => Effect.gen(function*() {
      stopped = true
      if (flowScopeCell !== undefined) {
        const closing = flowScopeCell
        flowScopeCell = undefined
        yield* Scope.close(closing, Exit.void)
      }
      if (options.store === undefined) memory.clear()
    })
  }
}
