import { whenPresent } from "@integrations/contracts"
import type { OAuthSessionState } from "@integrations/contracts"

import type { AuthMethod } from "@integrations/contracts"
import { Context, Deferred, Effect, Exit, Schema, Scope } from "effect"
import type { TenantId } from "./domain.ts"
import { webCrypto } from "@integrations/contracts"
import { completeOAuthFlow } from "@integrations/integrations"
import {
  authorizeInBrowser,
  OAuthFlowError,
  startHostedAuthorization,
  type OAuthOperations
} from "./oauth.ts"

export type OAuthSession = {
  readonly id: string
  readonly integration: string
  readonly connection: string
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

export interface OAuthSessionStore {
  put(session: OAuthSession): Effect.Effect<void, OAuthSessionError>
  get(id: string): Effect.Effect<OAuthSession | undefined, OAuthSessionError>
  putState(state: string, sessionId: string): Effect.Effect<void, OAuthSessionError>
  findState(state: string): Effect.Effect<string | undefined, OAuthSessionError>
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
  }): Effect.Effect<OAuthSession, OAuthSessionError | OAuthFlowError>
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
  readonly store?: OAuthSessionStore
  readonly onConnected?: (session: OAuthSession) => Promise<void>
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
      const id = yield* Effect.orDie(webCrypto.randomUUIDv4)
      const publicUrl = options.publicUrlOf?.() ?? options.publicUrl

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
      if (flowScopeCell !== undefined) {
        const closing = flowScopeCell
        flowScopeCell = undefined
        yield* Scope.close(closing, Exit.void)
      }
      if (options.store === undefined) memory.clear()
    })
  }
}
