import { whenPresent } from "@mokronos/wfkit"
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

export interface OAuthSessions {
  start(input: {
    readonly integration: string
    readonly connection: string
    readonly authMethod: ExecutorAuthMethod
    readonly clientId?: string
    readonly clientSecret?: string
    readonly timeoutMs?: number
  }): Promise<OAuthSession>
  get(id: string): OAuthSession | undefined
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
}

/** Sessions live in memory only. An in-flight browser redirect cannot survive a
 * daemon restart anyway — locally the ephemeral callback listener goes with
 * it; hosted, the provider's redirect is short-lived enough that a restart
 * means "start over" — so persisting them would just create rows that can
 * never complete.
 *
 * The gateway runs the flow and the caller polls, which is what lets the CLI
 * exit instead of holding a process open across a human's browser trip. */
export const createOAuthSessions = (
  executor: Pick<ExecutorServices, "auth">,
  options: OAuthSessionsOptions = {}
): OAuthSessions => {
  const sessions = new Map<string, OAuthSession>()
  // The provider echoes our state back verbatim; this is how a callback that
  // arrives without any session context finds its flow.
  const flowsByState = new Map<string, string>()
  let stopped = false

  const put = (session: OAuthSession): void => {
    sessions.set(session.id, session)
  }

  const finish = (id: string, state: OAuthSessionState): void => {
    const existing = sessions.get(id)
    if (existing === undefined) return
    put({ ...existing, state })
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
          put(connected)
          return connected
        }
        flowsByState.set(flow.state, id)
        const pending: OAuthSession = {
          id,
          integration: input.integration,
          connection: input.connection,
          state: { status: "pending", authorizationUrl: flow.authorizationUrl }
        }
        put(pending)
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
        (connection) => {
          finish(id, { status: "connected", connection })
          // A provider that short-circuits to an existing connection never
          // announces a URL, so unblock the caller either way.
          announced.resolve("")
        },
        (error) => {
          const message = error instanceof Error ? error.message : "OAuth authorization failed"
          finish(id, { status: "failed", message })
          announced.resolve("")
        }
      )

      const authorizationUrl = await announced.promise
      const session: OAuthSession = sessions.get(id) ?? {
        id,
        integration: input.integration,
        connection: input.connection,
        state: { status: "pending", authorizationUrl }
      }
      put(session)
      return session
    },

    get: (id) => sessions.get(id),

    completeByState: async (state, input) => {
      const id = flowsByState.get(state)
      if (id === undefined || stopped) return undefined
      const session = sessions.get(id)
      if (session === undefined || session.state.status !== "pending") return undefined
      // Consumed either way: a state completes once, so a replayed callback
      // finds nothing here.
      flowsByState.delete(state)
      try {
        const connection = await executor.auth.complete({
          state,
          code: input.code,
          ...whenPresent("callbackDomain", input.callbackDomain)
        })
        finish(id, { status: "connected", connection })
      } catch (error) {
        finish(id, {
          status: "failed",
          message: error instanceof Error ? error.message : "OAuth callback could not be verified"
        })
      }
      return sessions.get(id)
    },

    stop: () => {
      stopped = true
      sessions.clear()
      flowsByState.clear()
    }
  }
}
