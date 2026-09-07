import { whenPresent } from "@mokronos/contracts"
import { randomUUID } from "node:crypto"

import type { AuthMethod, Connection } from "@mokronos/contracts"
import { Context, Deferred, Effect, Exit, Schema, Scope } from "effect"
import type { TenantId } from "./domain.ts"
import { completeOAuthFlow } from "@mokronos/integrations"
import {
  authorizeInBrowser,
  OAuthFlowError,
  startHostedAuthorization,
  type OAuthOperations
} from "./oauth.ts"

export type OAuthSessionState =
  | { readonly status: "pending"; readonly authorizationUrl: string }
  | { readonly status: "connected"; readonly connection: Connection }
  | { readonly status: "failed"; readonly message: string }

export type OAuthSession = {
  readonly id: string
  readonly integration: string
  readonly connection: string
  /** Whose partition the finished connection belongs to. A tenant rather than
   *  a client, because a signed-in human connects on nobody's key. */
  readonly bindingTenant?: TenantId
  readonly state: OAuthSessionState
}

export class OAuthSessionError extends Schema.TaggedError<OAuthSessionError>()(
  "OAuthSessionError",
  {
    operation: Schema.String,
    cause: Schema.Defect()
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
    readonly bindingTenant?: TenantId
    // `OAuthFlowError` rides alongside `OAuthSessionError` rather than being
    // flattened into it: the two answer different questions. A session error is
    // the gateway's bookkeeping failing; a flow error says which stage of the
    // authorization the provider or the configuration broke at.
  }): Effect.Effect<OAuthSession, OAuthSessionError | OAuthFlowError>
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
  /** The host services an authorization reaches. A context rather than a layer
   *  because the host is already running by the time sessions exist. */
  host: Context.Context<OAuthOperations>,
  options: OAuthSessionsOptions = {}
): OAuthSessions => {
  // The in-memory backend is always constructed (it is two Maps); it backs
  // the sessions unless a shared store was injected, and only then owns
  // disposable state worth clearing.
  const memory = inMemoryStore()
  const store: OAuthSessionStore = options.store ?? memory
  let stopped = false

  /** Where in-flight local flows live. Created on first use rather than at
   *  construction, so a gateway that never runs a local flow never opens one,
   *  and closed by {@link OAuthSessions.stop} — which is what finally makes a
   *  shutdown able to cancel an authorization a human abandoned. */
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
        const flow = yield* startHostedAuthorization({
          integration: input.integration,
          connection: input.connection,
          authMethod: input.authMethod,
          publicUrl,
          ...whenPresent("clientId", input.clientId),
          ...whenPresent("clientSecret", input.clientSecret),
          ...whenPresent("timeoutMs", input.timeoutMs)
        }).pipe(Effect.provide(host))
        if (flow.status === "connected") {
          const connected: OAuthSession = {
            id,
            integration: input.integration,
            connection: input.connection,
            ...whenPresent("bindingTenant", input.bindingTenant),
            state: { status: "connected", connection: flow.connection }
          }
          yield* store.put(connected)
          if (options.onConnected !== undefined) {
            yield* external("bindConnectedTools", () => options.onConnected!(connected))
          }
          return connected
        }
        yield* store.putState(flow.state, id)
        const pending: OAuthSession = {
          id,
          integration: input.integration,
          connection: input.connection,
          ...whenPresent("bindingTenant", input.bindingTenant),
          state: { status: "pending", authorizationUrl: flow.authorizationUrl }
        }
        yield* store.put(pending)
        return pending
      }

      // Local mode: the flow owns an ephemeral loopback listener and resolves
      // through it. `start` returns once the provider's authorization URL is
      // known, which is well before the human finishes authorizing, so the rest
      // of the flow runs on a fiber.
      //
      // That fiber is forked into a scope this session manager owns, which is
      // what `stop()` closes. Before, it was a bare `void promise.then(...)`
      // re-entering Effect through `runPromiseWith`: nothing supervised it, a
      // shutdown could not cancel it, and a failure inside either `.then` arm
      // was discarded by the `void`.
      const parent = yield* flowScope
      const announced = yield* Deferred.make<string>()

      yield* authorizeInBrowser({
        integration: input.integration,
        connection: input.connection,
        authMethod: input.authMethod,
        ...whenPresent("clientId", input.clientId),
        ...whenPresent("clientSecret", input.clientSecret),
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
                yield* external("bindConnectedTools", () => options.onConnected!(session))
              }
            }),
          onFailure: (failure) => finish(id, { status: "failed", message: failure.message })
        }),
        // Recording the outcome is itself fallible — the store can refuse. It
        // cannot fail the flow (the human has already authorized), so it is
        // logged rather than dropped.
        Effect.catch((failure) =>
          Effect.logError(`OAuth session ${id} could not be settled: ${failure.message}`).pipe(
            Effect.annotateLogs({ session: id, operation: "OAuthSession.settle" })
          )),
        // A provider that short-circuits to an existing connection never
        // announces a URL, so unblock `start` however this ends.
        Effect.ensuring(Effect.sync(() => {
          Deferred.doneUnsafe(announced, Effect.succeed(""))
        })),
        // The listener belongs to this flow and is released when it settles;
        // the fiber belongs to the manager and dies when `stop()` closes it.
        Effect.scoped,
        Effect.forkIn(parent)
      )

      const authorizationUrl = yield* Deferred.await(announced)
      const session = (yield* store.get(id)) ?? {
        id,
        integration: input.integration,
        connection: input.connection,
        ...whenPresent("bindingTenant", input.bindingTenant),
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
      const result = yield* Effect.result(
        completeOAuthFlow({ state, code: input.code }).pipe(Effect.provide(host))
      )
      if (result._tag === "Success") {
        yield* finish(id, { status: "connected", connection: result.success })
        const completed = yield* store.get(id)
        if (completed !== undefined && options.onConnected !== undefined) {
          yield* external("bindConnectedTools", () => options.onConnected!(completed))
        }
      } else {
        yield* finish(id, { status: "failed", message: result.failure.message })
      }
      return yield* store.get(id)
    }),

    stop: () => Effect.gen(function*() {
      stopped = true
      // Closing the scope interrupts every in-flight authorization and, through
      // each flow's own scope, stops its loopback listener.
      if (flowScopeCell !== undefined) {
        const closing = flowScopeCell
        flowScopeCell = undefined
        yield* Scope.close(closing, Exit.void)
      }
      if (options.store === undefined) memory.clear()
    })
  }
}
