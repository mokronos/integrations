import { chmod, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { Config, DateTime, Duration, Effect, Option, Predicate, Schedule, Schema } from "effect"
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { HttpClientResponse, HttpMethod } from "effect/unstable/http"
import {
  integrationsHome,
  makeGatewayClient,
  readGatewayMetadata,
  readGatewayConfig,
  resolveClientConnection
} from "@mokronos/integrations-client"
import type { GatewayClient } from "@mokronos/integrations-client"
import { cliError, IntegrationsCliError } from "./connection.ts"
import { openBrowser } from "./connection.ts"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { optionalText, whenPresentMap } from "@mokronos/contracts"

const OperatorSession = Schema.Struct({
  url: Schema.String,
  token: Schema.String,
  email: Schema.String
})
export type OperatorSession = typeof OperatorSession.Type

const OperatorSessionJson = Schema.fromJsonString(OperatorSession)
const decodeOperatorSession = Schema.decodeUnknownSync(OperatorSessionJson)
const encodeOperatorSession = Schema.encodeSync(OperatorSessionJson)

export const operatorSessionPath = (): string =>
  path.join(integrationsHome(), "operator-session.json")

const configuredUrl = optionalText("INTEGRATIONS_URL").pipe(
  Config.map(Option.map((value) => value.replace(/\/+$/, "")))
)

const attempt = <A>(work: () => Promise<A>): Effect.Effect<A, IntegrationsCliError> =>
  Effect.tryPromise({
    try: work,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    catch: (cause: unknown) =>
      cause instanceof IntegrationsCliError
        ? cause
        : cliError(cause instanceof Error ? cause.message : String(cause))
  })

export const resolveGatewayUrl = Effect.fn("session.resolveGatewayUrl")(function*(): Effect.fn
  .Return<string, IntegrationsCliError> {
  const explicit = yield* Effect.orDie(configuredUrl)
  if (Option.isSome(explicit)) return explicit.value
  const config = yield* attempt(() => readGatewayConfig(integrationsHome()))
  if (config !== undefined) return config.url.replace(/\/+$/, "")
  return yield* cliError(
    "No gateway found. Set INTEGRATIONS_URL, or start the local gateway with `ii serve`."
  )
})

export const readOperatorSession = Effect.fn("session.read")(function*(): Effect.fn.Return<
  OperatorSession | undefined,
  IntegrationsCliError
> {
  const file = Bun.file(operatorSessionPath())
  if (!(yield* attempt(() => file.exists()))) return undefined
  const source = yield* attempt(() => file.text())
  return yield* Effect.try({
    try: () => decodeOperatorSession(source),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    catch: (cause: unknown) =>
      cliError(
        `The saved ii session is invalid: ${cause instanceof Error ? cause.message : String(cause)}`
      )
  })
})

export const writeOperatorSession = Effect.fn("session.write")((session: OperatorSession) =>
  attempt(async () => {
    const destination = operatorSessionPath()
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await Bun.write(destination, `${encodeOperatorSession(session)}\n`)
    await chmod(destination, 0o600)
  })
)

export const clearOperatorSession = Effect.fn("session.clear")(() =>
  attempt(() => rm(operatorSessionPath(), { force: true }))
)

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const messageFrom = (payload: typeof Schema.Json.Type, fallback: string): string => {
  if (Predicate.isObject(payload) && "error" in payload) {
    const error = payload["error"]
    if (Predicate.isString(error) && error.length > 0) return error
  }
  return fallback
}

const responseJson = Effect.fn("session.responseJson")((
  response: HttpClientResponse.HttpClientResponse
) =>
  response.text.pipe(
    Effect.mapError((cause) => cliError(cause.message)),
    Effect.flatMap((source) =>
      source.trim().length === 0
        ? Effect.succeed<typeof Schema.Json.Type>({})
        : decodeJsonText(source).pipe(
          Effect.mapError((cause) => cliError(cause.message))
        )
    )
  )
)

const gatewayCall = Effect.fn("session.call")(function*(
  method: HttpMethod.HttpMethod,
  url: string,
  options: {
    readonly headers?: Record<string, string>
    readonly body?: typeof Schema.Json.Type
  } = {}
): Effect.fn.Return<
  { readonly response: HttpClientResponse.HttpClientResponse; readonly payload: typeof Schema.Json.Type },
  IntegrationsCliError,
  HttpClient.HttpClient
> {
  const request = HttpClientRequest.make(method)(url, { headers: options.headers ?? {} })
  const response = yield* HttpClient.execute(
    options.body === undefined
      ? request
      : HttpClientRequest.setBody(request, HttpBody.jsonUnsafe(options.body))
  ).pipe(Effect.mapError((cause) => cliError(cause.message)))
  return { response, payload: yield* responseJson(response) }
})

const isOk = (response: HttpClientResponse.HttpClientResponse): boolean =>
  response.status >= 200 && response.status < 300

const CliLoginStart = Schema.Struct({
  requestId: Schema.String,
  authorizationUrl: Schema.String,
  expiresAt: Schema.String,
  intervalMs: Schema.Number
})

const CliLoginPoll = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending"), expiresAt: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("authenticated"),
    token: Schema.String,
    email: Schema.String
  })
])

const decodeLoginStart = Schema.decodeUnknownEffect(CliLoginStart)
const decodeLoginPoll = Schema.decodeUnknownEffect(CliLoginPoll)
const decodeSession = Schema.decodeUnknownEffect(OperatorSession)

const decoded = <A>(
  effect: Effect.Effect<A, Schema.SchemaError>
): Effect.Effect<A, IntegrationsCliError> =>
  Effect.mapError(effect, (cause) => cliError(cause.message))

const sessionToken = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<string, IntegrationsCliError> => {
  const match = /(?:^|;\s*)wf_session=([^;]+)/.exec(response.headers["set-cookie"] ?? "")
  return match?.[1] === undefined
    ? Effect.fail(cliError("The gateway accepted the login but did not return a session"))
    : Effect.succeed(match[1])
}

const verifyGateway = (url: string): Effect.Effect<void, IntegrationsCliError, HttpClient.HttpClient> =>
  readGatewayMetadata(url).pipe(
    Effect.mapError((cause) => cliError(cause.message)),
    Effect.asVoid
  )

export const loginOperator = Effect.fn("session.login")(function*(input: {
  readonly email: string
  readonly password: string
}): Effect.fn.Return<OperatorSession, IntegrationsCliError, HttpClient.HttpClient> {
  const url = yield* resolveGatewayUrl()
  yield* verifyGateway(url)
  const { response, payload } = yield* gatewayCall("POST", `${url}/v1/auth/login`, {
    body: input
  })
  if (!isOk(response)) {
    return yield* cliError(messageFrom(payload, `Login failed with ${response.status}`))
  }
  const session = yield* decoded(decodeSession({
    url,
    token: yield* sessionToken(response),
    email: input.email
  }))
  yield* writeOperatorSession(session)
  return session
})

export const loginOperatorInBrowser = Effect.fn("session.loginInBrowser")(function*(options: {
  readonly noOpen?: boolean
  readonly timeoutSeconds?: number
  readonly onAuthorization?: (url: string) => Promise<void>
} = {}): Effect.fn.Return<
  OperatorSession,
  IntegrationsCliError,
  ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> {
  const url = yield* resolveGatewayUrl()
  yield* verifyGateway(url)
  const started = yield* gatewayCall("POST", `${url}/v1/auth/cli/start`)
  if (!isOk(started.response)) {
    return yield* cliError(
      messageFrom(started.payload, `Browser login failed with ${started.response.status}`)
    )
  }
  const start = yield* decoded(decodeLoginStart(started.payload))
  if (options.onAuthorization !== undefined) {
    yield* attempt(() => options.onAuthorization!(start.authorizationUrl))
  }
  if (options.noOpen !== true) yield* openBrowser(start.authorizationUrl)

  // Wait no longer than the gateway says the request is good for, and no
  // longer than the caller asked to wait.
  const patience = Duration.min(
    DateTime.distance(yield* DateTime.now, DateTime.makeUnsafe(start.expiresAt)),
    Duration.seconds(options.timeoutSeconds ?? 300)
  )
  const settled = yield* Effect.gen(function*() {
    const polled = yield* gatewayCall(
      "GET",
      `${url}/v1/auth/cli/${encodeURIComponent(start.requestId)}`
    )
    if (!isOk(polled.response)) {
      return yield* cliError(
        messageFrom(polled.payload, `Browser login failed with ${polled.response.status}`)
      )
    }
    const poll = yield* decoded(decodeLoginPoll(polled.payload))
    if (poll.status !== "authenticated") return undefined
    return yield* decoded(decodeSession({ url, token: poll.token, email: poll.email }))
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.max(Duration.millis(250), Duration.millis(start.intervalMs))),
      while: (session) => session === undefined
    }),
    Effect.timeoutOrElse({ duration: patience, orElse: () => Effect.succeed(undefined) })
  )
  if (settled === undefined) {
    return yield* cliError("Browser login timed out. Run `ii login` to start a fresh sign-in.")
  }
  yield* writeOperatorSession(settled)
  return settled
})

export const signupOperator = Effect.fn("session.signup")(function*(input: {
  readonly email: string
  readonly password: string
  readonly tenantName?: string
}): Effect.fn.Return<OperatorSession, IntegrationsCliError, HttpClient.HttpClient> {
  const url = yield* resolveGatewayUrl()
  yield* verifyGateway(url)
  const { response, payload } = yield* gatewayCall("POST", `${url}/v1/auth/signup`, {
    body: input
  })
  if (!isOk(response)) {
    return yield* cliError(messageFrom(payload, `Signup failed with ${response.status}`))
  }
  const session = yield* decoded(decodeSession({
    url,
    token: yield* sessionToken(response),
    email: input.email
  }))
  yield* writeOperatorSession(session)
  return session
})

export interface ControlPlaneClient {
  readonly url: string
  readonly request: (
    method: "GET" | "POST" | "DELETE",
    route: string,
    body?: typeof Schema.Json.Type
  ) => Effect.Effect<typeof Schema.Json.Type, IntegrationsCliError, HttpClient.HttpClient>
}

const controlPlaneRequest = (
  url: string,
  headers: Record<string, string>
): ControlPlaneClient["request"] =>
  Effect.fn("session.controlPlaneRequest")(function*(method, route, body) {
    const { response, payload } = yield* gatewayCall(method, `${url}${route}`, {
      headers,
      ...whenPresentMap("body", body, (present) => present)
    })
    if (!isOk(response)) {
      return yield* cliError(
        messageFrom(payload, `${method} ${route} failed with ${response.status}`)
      )
    }
    return payload
  })

export const connectToControlPlane = Effect.fn("session.connectToControlPlane")(
  function*(): Effect.fn.Return<ControlPlaneClient, IntegrationsCliError, HttpClient.HttpClient> {
    const session = yield* readOperatorSession()
    if (session === undefined) {
      const connection = yield* attempt(() => resolveClientConnection())
      if (connection === undefined) {
        return yield* cliError(
          "No operator credential found. Sign in with `ii login`, or configure an administrative API key."
        )
      }
      yield* verifyGateway(connection.url)
      return {
        url: connection.url,
        request: controlPlaneRequest(connection.url, {
          authorization: `Bearer ${connection.apiKey}`
        })
      }
    }
    const selectedUrl = yield* resolveGatewayUrl()
    if (selectedUrl !== session.url) {
      return yield* cliError(
        `The saved session belongs to ${session.url}, but the selected gateway is ${selectedUrl}. Run \`ii login\` again.`
      )
    }
    yield* verifyGateway(session.url)
    return {
      url: session.url,
      request: controlPlaneRequest(session.url, {
        cookie: `wf_session=${session.token}`,
        origin: session.url
      })
    }
  }
)

export const connectToOperatorGateway = Effect.fn("session.connectToOperatorGateway")(
  function*(): Effect.fn.Return<GatewayClient, IntegrationsCliError, HttpClient.HttpClient> {
    const session = yield* readOperatorSession()
    if (session === undefined) {
      const connection = yield* attempt(() => resolveClientConnection())
      if (connection === undefined) {
        return yield* cliError(
          "No operator credential found. Sign in with `ii login`, or configure an administrative API key."
        )
      }
      return yield* makeGatewayClient(connection)
    }
    const selectedUrl = yield* resolveGatewayUrl()
    if (selectedUrl !== session.url) {
      return yield* cliError(
        `The saved session belongs to ${session.url}, but the selected gateway is ${selectedUrl}. Run \`ii login\` again.`
      )
    }
    return yield* makeGatewayClient({
      url: session.url,
      apiKey: "operator-session-transport"
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.mapRequest(
          yield* HttpClient.HttpClient,
          (request) =>
            HttpClientRequest.setHeaders(
              HttpClientRequest.removeHeader(request, "authorization"),
              { cookie: `wf_session=${session.token}`, origin: session.url }
            )
        )
      )
    )
  }
)

export const logoutOperator = Effect.fn("session.logout")(function*(): Effect.fn.Return<
  void,
  IntegrationsCliError,
  HttpClient.HttpClient
> {
  const session = yield* readOperatorSession()
  if (session === undefined) return
  yield* gatewayCall("POST", `${session.url}/v1/auth/logout`, {
    headers: { cookie: `wf_session=${session.token}`, origin: session.url }
  }).pipe(Effect.ignore, Effect.ensuring(Effect.orDie(clearOperatorSession())))
})
