import { whenPresent } from "@mokronos/contracts"
import { randomUUID } from "node:crypto"
import type { IntegrationsApi } from "@mokronos/integration-host"
import type { AuthMethod, Connection } from "@mokronos/contracts"
import { Effect, Schema } from "effect"
import type { Client } from "./domain.ts"
import {
  authorizeInBrowser,
  startHostedAuthorization
} from "./oauth.ts"

export type OAuthSessionState =
  | { readonly status: "pending"; readonly authorizationUrl: string }
  | { readonly status: "connected"; readonly connection: Connection }
  | { readonly status: "failed"; readonly message: string }

export type OAuthSession = {
  readonly id: string
  readonly integration: string
  readonly connection: string
  readonly grantClient?: Client
  readonly state: OAuthSessionState
}

export class OAuthSessionError extends Schema.TaggedErrorClass<OAuthSessionError>()(
  "OAuthSessionError",
  {
    operation: Schema.String,
    cause: Schema.Defect
  }
) {}

/** Where sessions live. The default keeps them in process memory — a browser
 *  redirect cannot survive a daemon restart anyway, so persisting them locally
 *  would just create rows that can never complete.
 *
 *  A deployment that can serve two requests from different processes (the
 *  Workers isolate pool) must inject a store: the start request and the
 *  provider's callback land wherever the edge sends them, and only shared
 *  storage lets the callback find its flow. */
export interface OAuthSessionStore {
  /** Inserts or overwrites the full session record. */
  put(session: OAuthSession): Effect.Effect<void, OAuthSessionError>
  get(id: string): Effect.Effect<OAuthSession | undefined, OAuthSessionError>
  /** Records which session a provider-echoed `state` belongs to. */
  putState(state: string, sessionId: string): Effect.Effect<void, OAuthSessionError>
  /** The session id a callback `state` belongs to, or undefined. */
  findState(state: string): Effect.Effect<string | undefined, OAuthSessionError>
  /** Consumes a state, so a replayed callback finds nothing here. */
  deleteState(state: string): Effect.Effect<void, OAuthSessionError>
}

export interface OAuthSessions {
  start(input: {
    readonly integration: string
    readonly connection: string
    readonly authMethod: AuthMethod
    readonly clientId?: string
    readonly clientSecret?: string
    readonly timeoutMs?: number
    readonly grantClient?: Client
  }): Effect.Effect<OAuthSession, OAuthSessionError>
  get(id: string): Effect.Effect<OAuthSession | undefined, OAuthSessionError>
  /** Finishes a hosted flow by the `state` the provider echoed back. Unknown
   *  or already-finished states answer `undefined`, which is what makes a
   *  replayed callback harmless rather than a second connection. */
  completeByState(
    state: string,
    input: { readonly code: string; readonly callbackDomain?: string | null }
  ): Effect.Effect<OAuthSession | undefined, OAuthSessionError>
  stop(): Effect.Effect<void>
}

export interface OAuthSessionsOptions {
  /** The gateway's externally reachable origin. Set on a hosted deployment:
   *  callbacks then arrive at `${publicUrl}/v1/oauth/callback` instead of an
   *  ephemeral loopback listener this process may not own. When the origin
   *  depends on the port the socket actually binds, supply it lazily via
   *  `publicUrlOf`, which is read at flow-start time. */
  readonly publicUrl?: string
  readonly publicUrlOf?: () => string | undefined
  /** Shared session storage for deployments that serve requests from more
   *  than one process. Absent means in-process memory, as always. */
  readonly store?: OAuthSessionStore
  readonly onConnected?: (session: OAuthSession) => Promise<void>
}

const inMemoryStore = (): OAuthSessionStore & { clear(): void } => {
  const sessions = new Map<string, OAuthSession>()
  // The provider echoes our state back verbatim; this is how a callback that
  // arrives without any session context finds its flow.
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

/** Sessions record where a flow stands; the caller polls, which is what lets
 *  the CLI exit instead of holding a process open across a human's browser
 *  trip. All reads and writes go through one backend so the flow logic never
 *  knows whether it is talking to maps or a database. */
export const createOAuthSessions = (
  integrations: Pick<IntegrationsApi, "auth">,
  options: OAuthSessionsOptions = {}
): OAuthSessions => {
  // The in-memory backend is always constructed (it is two Maps); it backs
  // the sessions unless a shared store was injected, and only then owns
  // disposable state worth clearing.
  const memory = inMemoryStore()
  const store: OAuthSessionStore = options.store ?? memory
  let stopped = false

  const finish = Effect.fn("OAuthSession.finish")(function*(
    id: string,
    state: OAuthSessionState
  ): Effect.fn.Return<void, OAuthSessionError> {
    const existing = yield* store.get(id)
    if (existing === undefined) return
    yield* store.put({ ...existing, state })
  })

  const external = <A>(operation: string, call: () => Promise<A>) =>
    Effect.tryPromise({
      try: call,
      catch: (cause) => new OAuthSessionError({ operation, cause })
    })

  return {
    start: Effect.fn("OAuthSession.start")(function*(input) {
      if (stopped) {
        return yield* new OAuthSessionError({
          operation: "start",
          cause: new Error("The gateway is shutting down")
        })
      }
      const id = randomUUID()
      const publicUrl = options.publicUrlOf?.() ?? options.publicUrl

      // Hosted mode: register against the public URL and hand back a URL for
      // the human's browser. Completion arrives at the callback route.
      if (publicUrl !== undefined) {
        const flow = yield* external("startHostedAuthorization", () => startHostedAuthorization({
          integration: input.integration,
          connection: input.connection,
          authMethod: input.authMethod,
          publicUrl,
          ...whenPresent("clientId", input.clientId),
          ...whenPresent("clientSecret", input.clientSecret),
          ...whenPresent("timeoutMs", input.timeoutMs)
        }, integrations.auth))
        if (flow.status === "connected") {
          const connected: OAuthSession = {
            id,
            integration: input.integration,
            connection: input.connection,
            ...whenPresent("grantClient", input.grantClient),
            state: { status: "connected", connection: flow.connection }
          }
          yield* store.put(connected)
          if (options.onConnected !== undefined) {
            yield* external("grantConnectedTools", () => options.onConnected!(connected))
          }
          return connected
        }
        yield* store.putState(flow.state, id)
        const pending: OAuthSession = {
          id,
          integration: input.integration,
          connection: input.connection,
          ...whenPresent("grantClient", input.grantClient),
          state: { status: "pending", authorizationUrl: flow.authorizationUrl }
        }
        yield* store.put(pending)
        return pending
      }

      // Local mode: the flow owns an ephemeral loopback listener and resolves
      // through it. Resolves once the provider's authorization URL is known,
      // which is well before the human finishes authorizing.
      const announced = Promise.withResolvers<string>()
      const context = yield* Effect.context<never>()
      const run = Effect.runPromiseWith(context)
      const flowPromise = authorizeInBrowser({
        integration: input.integration,
        connection: input.connection,
        authMethod: input.authMethod,
        ...whenPresent("clientId", input.clientId),
        ...whenPresent("clientSecret", input.clientSecret),
        ...whenPresent("timeoutMs", input.timeoutMs),
        onAuthorizationUrl: (url) => announced.resolve(url)
      }, integrations.auth)

      void flowPromise.then(
        (connection) => {
          void run(Effect.gen(function*() {
            yield* finish(id, { status: "connected", connection })
            const session = yield* store.get(id)
            if (session !== undefined && options.onConnected !== undefined) {
              yield* external("grantConnectedTools", () => options.onConnected!(session))
            }
          }))
          // A provider that short-circuits to an existing connection never
          // announces a URL, so unblock the caller either way.
          announced.resolve("")
        },
        (error) => {
          const message = error instanceof Error ? error.message : "OAuth authorization failed"
          void run(finish(id, { status: "failed", message }))
          announced.resolve("")
        }
      )

      const authorizationUrl = yield* external("announceAuthorizationUrl", () => announced.promise)
      const session = (yield* store.get(id)) ?? {
        id,
        integration: input.integration,
        connection: input.connection,
        ...whenPresent("grantClient", input.grantClient),
        state: { status: "pending", authorizationUrl }
      }
      yield* store.put(session)
      return session
    }),

    get: (id) => store.get(id),

    completeByState: Effect.fn("OAuthSession.completeByState")(function*(state, input) {
      if (stopped) return undefined
      const id = yield* store.findState(state)
      if (id === undefined) return undefined
      // Consumed either way: a state completes once, so a replayed callback
      // finds nothing here.
      yield* store.deleteState(state)
      const session = yield* store.get(id)
      if (session === undefined || session.state.status !== "pending") return undefined
      const result = yield* Effect.result(external("completeAuthorization", () =>
        integrations.auth.complete({
          state,
          code: input.code,
          ...whenPresent("callbackDomain", input.callbackDomain)
        })))
      if (result._tag === "Success") {
        yield* finish(id, { status: "connected", connection: result.success })
        const completed = yield* store.get(id)
        if (completed !== undefined && options.onConnected !== undefined) {
          yield* external("grantConnectedTools", () => options.onConnected!(completed))
        }
      } else {
        const error = result.failure
        yield* finish(id, {
          status: "failed",
          message: error.cause instanceof Error
            ? error.cause.message
            : "OAuth callback could not be verified"
        })
      }
      return yield* store.get(id)
    }),

    stop: () => Effect.sync(() => {
      stopped = true
      if (options.store === undefined) memory.clear()
    })
  }
}
