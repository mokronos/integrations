import { Deferred, Duration, Effect } from "effect"
import type { Scope } from "effect"
import type { Connection } from "@integragents/contracts"
import { completeOAuthFlow } from "@integragents/host"
import {
  decodeAuthorizationRequest,
  OAuthFlowError,
  oauthBrowserPage,
  oauthStep,
  prepareFlow
} from "@integragents/gateway-core"
import type { AuthorizationRequest, OAuthOperations } from "@integragents/gateway-core"

export const oauthBrowserResponse = (options: {
  readonly title: string
  readonly message: string
  readonly status?: number
}): Response =>
  new Response(oauthBrowserPage(options), {
    status: options.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  })

export const authorizeInBrowser = Effect.fn("OAuth.authorizeInBrowser")(function* (
  input: AuthorizationRequest & {
    readonly open?: (url: string) => void | Promise<void>
    readonly onAuthorizationUrl?: (url: string) => void
  }
): Effect.fn.Return<Connection, OAuthFlowError, Scope.Scope | OAuthOperations> {
  const arrived = yield* Deferred.make<URLSearchParams>()
  const rendered = Promise.withResolvers<Response>()
  let callbackStarted = false
  let expectedState: string | undefined

  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request): Promise<Response> {
          const url = new URL(request.url)
          if (request.method !== "GET" || url.pathname !== "/oauth/callback") {
            return new Response("Not found", { status: 404 })
          }
          if (callbackStarted) {
            return oauthBrowserResponse({
              title: "Authorization unavailable",
              message: "This authorization callback is no longer active. Return to the terminal and try again.",
              status: 409
            })
          }
          const state = url.searchParams.get("state")
          if (state === null || expectedState === undefined || state !== expectedState) {
            return oauthBrowserResponse({
              title: "Authorization failed",
              message: "The callback state could not be verified. Return to the terminal and try again.",
              status: 400
            })
          }
          callbackStarted = true
          Deferred.doneUnsafe(arrived, Effect.succeed(url.searchParams))
          return await rendered.promise
        }
      })
    ),
    (running) =>
      Effect.promise(async () => {
        rendered.resolve(
          oauthBrowserResponse({
            title: "Authorization failed",
            message: "The authorization did not complete. Return to the terminal and try again.",
            status: 400
          })
        )
        await running.stop(false)
      })
  )

  const timeoutMillis = Math.max(1_000, input.timeoutMs ?? 300_000)
  const options = yield* decodeAuthorizationRequest(input)
  const prepared = yield* prepareFlow(options, `http://127.0.0.1:${server.port}/oauth/callback`)
  if (prepared.status === "connected") return prepared.connection

  expectedState = prepared.state
  input.onAuthorizationUrl?.(prepared.authorizationUrl)
  if (input.open !== undefined) {
    const open = input.open
    yield* oauthStep(
      "start",
      "Could not open the authorization URL",
      Effect.tryPromise({
        try: async () => {
          await open(prepared.authorizationUrl)
        },
        catch: (cause) => ({
          message: cause instanceof Error ? cause.message : String(cause)
        })
      })
    )
  }

  const callback = yield* Deferred.await(arrived).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMillis),
      orElse: () =>
        new OAuthFlowError({
          stage: "timeout",
          detail: `OAuth authorization timed out after ${Math.ceil(timeoutMillis / 1000)} seconds`
        })
    })
  )

  const exchanged = yield* Effect.result(
    oauthStep("exchange", `${input.integration} refused the authorization code`, completeOAuthFlow(callback))
  )
  if (exchanged._tag === "Failure") {
    rendered.resolve(
      oauthBrowserResponse({
        title: "Authorization failed",
        message: `The callback could not be verified: ${exchanged.failure.message}`,
        status: 400
      })
    )
    return yield* exchanged.failure
  }
  rendered.resolve(
    oauthBrowserResponse({
      title: "Account connected",
      message: "Authorization completed. You can close this window and return to wf."
    })
  )
  return exchanged.success
})
