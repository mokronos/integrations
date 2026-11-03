import { Deferred, Duration, Effect } from "effect"
import type { Scope } from "effect"
import type { Connection } from "@integragents/contracts"
import { completeOAuthFlow } from "@integragents/integrations"
import {
  decodeAuthorizationRequest,
  OAuthFlowError,
  oauthBrowserPage,
  oauthStep,
  pageIntegration,
  prepareFlow,
  providerRefusalOf,
  toGatewayError
} from "@integragents/gateway-core"
import type { AuthorizationRequest, BrowserPage, OAuthOperations } from "@integragents/gateway-core"
import { currentTraceId } from "./http/observability.ts"

const browserResponse = (status: number, page: BrowserPage): Response =>
  new Response(oauthBrowserPage(page), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  })

const callbackRefusal = (params: URLSearchParams) =>
  providerRefusalOf({
    error: params.get("error") ?? undefined,
    error_description: params.get("error_description") ?? undefined,
    error_uri: params.get("error_uri") ?? undefined
  })

export const authorizeInBrowser = Effect.fn("OAuth.authorizeInBrowser")(function* (
  input: AuthorizationRequest & {
    readonly open?: (url: string) => void | Promise<void>
    readonly onAuthorizationUrl?: (url: string) => void
  }
): Effect.fn.Return<Connection, OAuthFlowError, Scope.Scope | OAuthOperations> {
  const traceId = yield* currentTraceId
  const integration = yield* pageIntegration(input.integration)
  const flow = `Connecting ${input.integration} (connection "${input.connection}") with OAuth`
  const failed = (
    status: number,
    content: Omit<Extract<BrowserPage, { readonly outcome: "failure" }>, "outcome" | "flow" | "traceId" | "integration">
  ): Response => browserResponse(status, { outcome: "failure", flow, traceId, integration, ...content })
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
            return failed(409, {
              title: "Authorization unavailable",
              message: "This authorization callback is no longer active. Return to the terminal and try again."
            })
          }
          const state = url.searchParams.get("state")
          if (state === null || expectedState === undefined || state !== expectedState) {
            return failed(400, {
              title: "Authorization failed",
              message: "The callback state could not be verified. Return to the terminal and try again.",
              provider: callbackRefusal(url.searchParams)
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
          failed(400, {
            title: "Authorization failed",
            message: "The authorization did not complete. Return to the terminal and try again."
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
          reason: "timeout",
          detail: `OAuth authorization timed out after ${Math.ceil(timeoutMillis / 1000)} seconds`
        })
    })
  )

  const exchanged = yield* Effect.result(
    oauthStep("exchange", `${input.integration} refused the authorization code`, completeOAuthFlow(callback))
  )
  if (exchanged._tag === "Failure") {
    const provider = callbackRefusal(callback)
    rendered.resolve(
      failed(400, {
        title: provider === undefined ? "Authorization failed" : "Authorization refused",
        message: provider?.description ?? provider?.error ?? `${input.integration} could not be connected.`,
        error: toGatewayError(exchanged.failure, input.integration),
        provider
      })
    )
    return yield* exchanged.failure
  }
  rendered.resolve(
    browserResponse(200, {
      outcome: "success",
      integration,
      title: `${integration.name} connected`,
      message: "You can close this window and return to the terminal or dashboard."
    })
  )
  return exchanged.success
})
