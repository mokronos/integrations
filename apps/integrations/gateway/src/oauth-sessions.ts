import { whenPresent } from "@mokronos/wfkit/optional"
import { randomUUID } from "node:crypto"
import type { ExecutorAuthMethod, ExecutorConnection, ExecutorServices } from "@mokronos/wfkit-executor"
import {
  authorizeExecutorInBrowser,
  startHostedExecutorOAuth
} from "./oauth.ts"

export type OAuthSessionState =
  | { readonly status: "pending"; readonly authorizationUrl: string }
  | { readonly status: "connected"; readonly connection: ExecutorConnection }
  | { readonly status: "failed"; readonly message: string }

export type OAuthSession = {
  readonly id: string
  readonly integration: string
  readonly connection: string
  readonly state: OAuthSessionState
}

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
  put(session: OAuthSession): Promise<void>
  get(id: string): Promise<OAuthSession | undefined>
  /** Records which session a provider-echoed `state` belongs to. */
  putState(state: string, sessionId: string): Promise<void>
  /** The session id a callback `state` belongs to, or undefined. */
  findState(state: string): Promise<string | undefined>
  /** Consumes a state, so a replayed callback finds nothing here. */
  deleteState(state: string): Promise<void>
}

export interface OAuthSessions {
  start(input: {
    readonly integration: string
    readonly connection: string
    readonly authMethod: ExecutorAuthMethod
    readonly clientId?: string
    readonly clientSecret?: string
    readonly timeoutMs?: number
  }): Promise<OAuthSession>
  get(id: string): Promise<OAuthSession | undefined>
  /** Finishes a hosted flow by the `state` the provider echoed back. Unknown
   *  or already-finished states answer `undefined`, which is what makes a
   *  replayed callback harmless rather than a second connection. */
  completeByState(
    state: string,
    input: { readonly code: string; readonly callbackDomain?: string | null }
  ): Promise<OAuthSession | undefined>
  stop(): void
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
}

const inMemoryStore = (): OAuthSessionStore & { clear(): void } => {
  const sessions = new Map<string, OAuthSession>()
  // The provider echoes our state back verbatim; this is how a callback that
  // arrives without any session context finds its flow.
  const flowsByState = new Map<string, string>()
  return {
    put: async (session) => {
      sessions.set(session.id, session)
    },
    get: async (id) => sessions.get(id),
    putState: async (state, sessionId) => {
      flowsByState.set(state, sessionId)
    },
    findState: async (state) => flowsByState.get(state),
    deleteState: async (state) => {
      flowsByState.delete(state)
    },
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
  executor: Pick<ExecutorServices, "auth">,
  options: OAuthSessionsOptions = {}
): OAuthSessions => {
  // The in-memory backend is always constructed (it is two Maps); it backs
  // the sessions unless a shared store was injected, and only then owns
  // disposable state worth clearing.
  const memory = inMemoryStore()
  const store: OAuthSessionStore = options.store ?? memory
  let stopped = false

  const finish = async (id: string, state: OAuthSessionState): Promise<void> => {
    const existing = await store.get(id)
    if (existing === undefined) return
    await store.put({ ...existing, state })
  }

  return {
    start: async (input) => {
      if (stopped) throw new Error("The gateway is shutting down")
      const id = randomUUID()
      const publicUrl = options.publicUrlOf?.() ?? options.publicUrl

      // Hosted mode: register against the public URL and hand back a URL for
      // the human's browser. Completion arrives at the callback route.
      if (publicUrl !== undefined) {
        const flow = await startHostedExecutorOAuth({
          integration: input.integration,
          connection: input.connection,
          authMethod: input.authMethod,
          publicUrl,
          ...whenPresent("clientId", input.clientId),
          ...whenPresent("clientSecret", input.clientSecret),
          ...whenPresent("timeoutMs", input.timeoutMs)
        }, executor.auth)
        if (flow.status === "connected") {
          const connected: OAuthSession = {
            id,
            integration: input.integration,
            connection: input.connection,
            state: { status: "connected", connection: flow.connection }
          }
          await store.put(connected)
          return connected
        }
        await store.putState(flow.state, id)
        const pending: OAuthSession = {
          id,
          integration: input.integration,
          connection: input.connection,
          state: { status: "pending", authorizationUrl: flow.authorizationUrl }
        }
        await store.put(pending)
        return pending
      }

      // Local mode: the flow owns an ephemeral loopback listener and resolves
      // through it. Resolves once the provider's authorization URL is known,
      // which is well before the human finishes authorizing.
      const announced = Promise.withResolvers<string>()
      const flowPromise = authorizeExecutorInBrowser({
        integration: input.integration,
        connection: input.connection,
        authMethod: input.authMethod,
        ...whenPresent("clientId", input.clientId),
        ...whenPresent("clientSecret", input.clientSecret),
        ...whenPresent("timeoutMs", input.timeoutMs),
        onAuthorizationUrl: (url) => announced.resolve(url)
      }, executor.auth)

      flowPromise.then(
        async (connection) => {
          await finish(id, { status: "connected", connection })
          // A provider that short-circuits to an existing connection never
          // announces a URL, so unblock the caller either way.
          announced.resolve("")
        },
        async (error) => {
          const message = error instanceof Error ? error.message : "OAuth authorization failed"
          await finish(id, { status: "failed", message })
          announced.resolve("")
        }
      )

      const authorizationUrl = await announced.promise
      const session = await store.get(id) ?? {
        id,
        integration: input.integration,
        connection: input.connection,
        state: { status: "pending", authorizationUrl }
      }
      await store.put(session)
      return session
    },

    get: (id) => store.get(id),

    completeByState: async (state, input) => {
      if (stopped) return undefined
      const id = await store.findState(state)
      if (id === undefined) return undefined
      // Consumed either way: a state completes once, so a replayed callback
      // finds nothing here.
      await store.deleteState(state)
      const session = await store.get(id)
      if (session === undefined || session.state.status !== "pending") return undefined
      try {
        const connection = await executor.auth.complete({
          state,
          code: input.code,
          ...whenPresent("callbackDomain", input.callbackDomain)
        })
        await finish(id, { status: "connected", connection })
      } catch (error) {
        await finish(id, {
          status: "failed",
          message: error instanceof Error ? error.message : "OAuth callback could not be verified"
        })
      }
      return store.get(id)
    },

    stop: () => {
      stopped = true
      if (options.store === undefined) memory.clear()
    }
  }
}
