import { chmod, mkdir, open, rm, stat } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"
import * as oauth from "oauth4webapi"
import { Clock, Duration, Effect, Option, Schedule, Schema } from "effect"
import type { HttpClient } from "effect/http"
import { makeGatewayClient, resolveClientConnection } from "@integragents/client"
import type { ClientConnection, GatewayClient } from "@integragents/client"
import { whenPresent } from "@integragents/contracts"
import type { CredentialIdentity } from "@integragents/contracts"
import { integrationsHome } from "@integragents/contracts/gateway-config"
import { cliError, IntegrationsCliError, thrownMessage } from "./connection.ts"

/**
 * `i login`: the OAuth device authorization grant (RFC 8628) against the
 * gateway's own authorization server. `i` registers itself, shows a code, and
 * a person who is signed in to the dashboard approves it for a profile. `i`
 * then holds a token for the gateway's API, never a key someone pasted.
 */

const deviceCodeGrant = "urn:ietf:params:oauth:grant-type:device_code"
const scope = "mcp offline_access"
/** Refresh this long before the access token runs out, so a call never starts with one about to lapse. */
const refreshMargin = Duration.minutes(1)

const PendingDevice = Schema.Struct({
  deviceCode: Schema.String,
  userCode: Schema.String,
  verificationUri: Schema.String,
  expiresAt: Schema.Number,
  intervalSeconds: Schema.Number
})
type PendingDevice = typeof PendingDevice.Type

const Tokens = Schema.Struct({
  access: Schema.String,
  refresh: Schema.String,
  expiresAt: Schema.Number
})
type Tokens = typeof Tokens.Type

const AgentLogin = Schema.Struct({
  url: Schema.String,
  /** The gateway's origin: its authorization server, and the API resource the tokens are for. */
  issuer: Schema.String,
  clientId: Schema.String,
  pending: Schema.optional(PendingDevice),
  tokens: Schema.optional(Tokens)
})
type AgentLogin = typeof AgentLogin.Type

const AgentLoginJson = Schema.fromJsonString(AgentLogin)
const decodeLogin = Schema.decodeUnknownEffect(AgentLoginJson)
const encodeLogin = Schema.encodeSync(AgentLoginJson)

export const agentLoginPath = (): string => path.join(integrationsHome(), "login.json")
const lockPath = (): string => `${agentLoginPath()}.lock`

const attempt = <A>(work: () => Promise<A>): Effect.Effect<A, IntegrationsCliError> =>
  Effect.tryPromise({
    try: work,
    catch: (cause) => cliError(thrownMessage(cause))
  })

const readLogin = Effect.fn("AgentLogin.read")(function* () {
  const file = Bun.file(agentLoginPath())
  if (!(yield* attempt(() => file.exists()))) return undefined
  return yield* decodeLogin(yield* attempt(() => file.text())).pipe(
    Effect.mapError(() => cliError(`${agentLoginPath()} is not a login \`i\` wrote. Delete it and run \`i login\`.`))
  )
})

const writeLogin = Effect.fn("AgentLogin.write")((login: AgentLogin) =>
  attempt(async () => {
    const destination = agentLoginPath()
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await Bun.write(destination, `${encodeLogin(login)}\n`)
    await chmod(destination, 0o600)
  })
)

/** The gateway the last `i login` was for, so a second `i login` finishes the same one. */
export const savedLoginUrl = Effect.map(
  Effect.suspend(() => readLogin()),
  (login) => login?.url
)

export const forgetAgentLogin = Effect.fn("AgentLogin.forget")(() =>
  attempt(() => rm(agentLoginPath(), { force: true }))
)

/** A gateway on plain HTTP is one on loopback or a private network the person chose; tokens go there as keys do. */
const transport = (issuer: URL) => (issuer.protocol === "http:" ? { [oauth.allowInsecureRequests]: true } : {})

/** An OAuth exchange whose error response the caller reads, such as `authorization_pending`. */
const oauthExchange = <A>(work: () => Promise<A>): Effect.Effect<A, oauth.ResponseBodyError | IntegrationsCliError> =>
  Effect.tryPromise({
    try: work,
    catch: (cause) =>
      cause instanceof oauth.ResponseBodyError
        ? cause
        : cliError(`The gateway's authorization server failed: ${thrownMessage(cause)}`)
  })

const oauthStep = <A>(work: () => Promise<A>): Effect.Effect<A, IntegrationsCliError> =>
  oauthExchange(work).pipe(
    Effect.catchIf(
      (cause) => cause instanceof oauth.ResponseBodyError,
      (cause) => Effect.fail(cliError(cause.error_description ?? cause.error))
    )
  )

const authorizationServer = (issuer: URL) =>
  oauthStep(async () =>
    oauth.processDiscoveryResponse(
      issuer,
      await oauth.discoveryRequest(issuer, {
        algorithm: "oauth2",
        ...transport(issuer)
      })
    )
  ).pipe(
    Effect.mapError(() =>
      cliError(
        `${issuer.origin} offers no login: it has no authorization server, usually because it has no public URL. Use an API key from its dashboard (INTEGRATIONS_URL and INTEGRATIONS_API_KEY) instead.`
      )
    )
  )

const register = (server: oauth.AuthorizationServer, issuer: URL) =>
  oauthStep(async () =>
    oauth.processDynamicClientRegistrationResponse(
      await oauth.dynamicClientRegistrationRequest(
        server,
        {
          client_name: `i on ${hostname()}`,
          grant_types: [deviceCodeGrant, "refresh_token"],
          token_endpoint_auth_method: "none"
        },
        transport(issuer)
      )
    )
  ).pipe(Effect.map((client) => client.client_id))

const startDevice = (server: oauth.AuthorizationServer, issuer: URL, clientId: string) =>
  Effect.gen(function* () {
    const client = { client_id: clientId }
    const started = yield* oauthStep(async () =>
      oauth.processDeviceAuthorizationResponse(
        server,
        client,
        await oauth.deviceAuthorizationRequest(
          server,
          client,
          oauth.None(),
          { scope, resource: issuer.origin },
          transport(issuer)
        )
      )
    )
    const pending: PendingDevice = {
      deviceCode: started.device_code,
      userCode: started.user_code,
      verificationUri: started.verification_uri_complete ?? started.verification_uri,
      expiresAt: (yield* Clock.currentTimeMillis) + started.expires_in * 1_000,
      intervalSeconds: started.interval ?? 5
    }
    return pending
  })

const tokensOf = (response: oauth.TokenEndpointResponse) =>
  Effect.gen(function* () {
    if (response.refresh_token === undefined) {
      return yield* cliError("The gateway issued no refresh token; `i` cannot stay logged in")
    }
    const tokens: Tokens = {
      access: response.access_token,
      refresh: response.refresh_token,
      expiresAt: (yield* Clock.currentTimeMillis) + (response.expires_in ?? 3_600) * 1_000
    }
    return tokens
  })

type Polled =
  | { readonly status: "authenticated"; readonly tokens: Tokens }
  | { readonly status: "pending" }
  | { readonly status: "refused"; readonly reason: string }

/** One poll of the token endpoint: tokens once the person approved, otherwise where the request stands. */
const poll = (server: oauth.AuthorizationServer, issuer: URL, clientId: string, pending: PendingDevice) =>
  oauthExchange(async () => {
    const client = { client_id: clientId }
    return oauth.processDeviceCodeResponse(
      server,
      client,
      await oauth.deviceCodeGrantRequest(server, client, oauth.None(), pending.deviceCode, {
        additionalParameters: { resource: issuer.origin },
        ...transport(issuer)
      })
    )
  }).pipe(
    Effect.flatMap(tokensOf),
    Effect.map((tokens): Polled => ({ status: "authenticated", tokens })),
    Effect.catchIf(
      (cause) => cause instanceof oauth.ResponseBodyError,
      (cause) => {
        switch (cause.error) {
          case "authorization_pending":
          case "slow_down":
            return Effect.succeed<Polled>({ status: "pending" })
          case "access_denied":
            return Effect.succeed<Polled>({
              status: "refused",
              reason: "The person denied this login."
            })
          default:
            return Effect.succeed<Polled>({
              status: "refused",
              reason: "The login code expired before anyone approved it."
            })
        }
      }
    )
  )

export type LoginResult =
  | { readonly status: "authenticated"; readonly url: string }
  | {
      readonly status: "pending"
      readonly url: string
      readonly pending: PendingDevice
    }

/**
 * Starts a device login, or picks up the one already waiting for this
 * gateway. Without `wait` it asks the gateway once and returns, so an agent
 * whose shell shows output only when a command ends still sees the code.
 */
export const loginToGateway = Effect.fn("AgentLogin.login")(function* (input: {
  readonly url: string
  readonly wait: Option.Option<Duration.Duration>
  readonly onPending: (pending: PendingDevice) => Effect.Effect<void>
}) {
  const url = input.url.replace(/\/+$/, "")
  const issuer = new URL(new URL(url).origin)
  const server = yield* authorizationServer(issuer)
  const saved = Option.filter(Option.fromNullishOr(yield* readLogin()), (login) => login.issuer === issuer.origin)
  const now = yield* Clock.currentTimeMillis
  const waiting = Option.flatMap(saved, ({ clientId, pending }) =>
    pending !== undefined && pending.expiresAt > now ? Option.some({ clientId, pending }) : Option.none()
  )

  const previousTokens = Option.getOrUndefined(saved)?.tokens
  const begin = (clientId: string) =>
    Effect.map(startDevice(server, issuer, clientId), (pending) => ({
      clientId,
      pending
    }))
  const { clientId, pending } = Option.isSome(waiting)
    ? waiting.value
    : yield* Option.match(saved, {
        onNone: () => Effect.flatMap(register(server, issuer), begin),
        onSome: (login) =>
          begin(login.clientId).pipe(Effect.catch(() => Effect.flatMap(register(server, issuer), begin)))
      }).pipe(
        Effect.tap((started) =>
          writeLogin({
            url,
            issuer: issuer.origin,
            ...started,
            ...whenPresent("tokens", previousTokens)
          })
        )
      )

  const settle = (polled: Polled) =>
    Effect.gen(function* () {
      switch (polled.status) {
        case "authenticated":
          yield* writeLogin({
            url,
            issuer: issuer.origin,
            clientId,
            tokens: polled.tokens
          })
          return { status: "authenticated", url } satisfies LoginResult
        case "refused":
          yield* writeLogin({
            url,
            issuer: issuer.origin,
            clientId,
            ...whenPresent("tokens", previousTokens)
          })
          return yield* cliError(`${polled.reason} Run \`i login\` to start again.`)
        case "pending":
          return { status: "pending", url, pending } satisfies LoginResult
      }
    })

  if (Option.isNone(input.wait)) {
    if (Option.isNone(waiting)) return { status: "pending", url, pending } satisfies LoginResult
    return yield* settle(yield* poll(server, issuer, clientId, pending))
  }

  yield* input.onPending(pending)
  const patience = Duration.min(input.wait.value, Duration.millis(Math.max(0, pending.expiresAt - now)))
  const polled = yield* poll(server, issuer, clientId, pending).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.seconds(pending.intervalSeconds)),
      while: (result) => result.status === "pending"
    }),
    Effect.timeoutOrElse({
      duration: patience,
      orElse: () => Effect.succeed<Polled>({ status: "pending" })
    })
  )
  return yield* settle(polled)
})

const lockStaleAfter = Duration.seconds(30)

/**
 * Only one `i` refreshes at a time. The gateway rotates refresh tokens and
 * treats a reused one as stolen, revoking the login, so two commands an
 * agent runs side by side must not both spend the same one.
 */
const refreshLock = Effect.acquireRelease(
  attempt(async () => {
    try {
      await (await open(lockPath(), "wx")).close()
      return true
    } catch {
      const held = await stat(lockPath()).catch(() => undefined)
      if (held !== undefined && Date.now() - held.mtimeMs > Duration.toMillis(lockStaleAfter)) {
        await rm(lockPath(), { force: true })
      }
      return false
    }
  }).pipe(
    Effect.flatMap((acquired) =>
      acquired ? Effect.void : Effect.fail(cliError("Another `i` is refreshing the login"))
    ),
    Effect.retry({
      schedule: Schedule.spaced(Duration.millis(100)),
      times: 100
    })
  ),
  () => Effect.ignore(attempt(() => rm(lockPath(), { force: true })))
)

const refreshed = (login: AgentLogin, tokens: Tokens) =>
  Effect.gen(function* () {
    const issuer = new URL(login.issuer)
    const server = yield* authorizationServer(issuer)
    const client = { client_id: login.clientId }
    const response = yield* oauthExchange(async () =>
      oauth.processRefreshTokenResponse(
        server,
        client,
        await oauth.refreshTokenGrantRequest(server, client, oauth.None(), tokens.refresh, {
          additionalParameters: { resource: issuer.origin },
          ...transport(issuer)
        })
      )
    ).pipe(
      Effect.catchIf(
        (cause) => cause instanceof oauth.ResponseBodyError,
        (cause) =>
          cause.error === "invalid_grant"
            ? Effect.flatMap(
                writeLogin({
                  url: login.url,
                  issuer: login.issuer,
                  clientId: login.clientId
                }),
                () =>
                  Effect.fail(
                    cliError(
                      "The gateway no longer accepts this login; it expired or was revoked. Run `i login` again."
                    )
                  )
              )
            : Effect.fail(cliError(`The login could not be refreshed: ${cause.error_description ?? cause.error}`))
      )
    )
    const next = yield* tokensOf(response)
    yield* writeLogin({ ...login, tokens: next })
    return next
  })

/** The token `i login` left, refreshed first when it is about to run out. */
const loggedIn = Effect.fn("AgentLogin.connection")(function* () {
  const saved = yield* readLogin()
  if (saved?.tokens === undefined) return undefined
  const fresh = (tokens: Tokens, now: number) => tokens.expiresAt - Duration.toMillis(refreshMargin) > now
  if (fresh(saved.tokens, yield* Clock.currentTimeMillis)) return { url: saved.url, apiKey: saved.tokens.access }
  const tokens = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* refreshLock
      const current = yield* readLogin()
      if (current?.tokens === undefined) return yield* cliError("The login was removed. Run `i login` again.")
      return fresh(current.tokens, yield* Clock.currentTimeMillis)
        ? current.tokens
        : yield* refreshed(current, current.tokens)
    })
  )
  return { url: saved.url, apiKey: tokens.access }
})

/**
 * Which gateway `i` talks to, as whom: a key set in the environment, then
 * what `i login` left, then the local gateway's own key.
 */
export const connectToGateway = Effect.fn("Cli.connectToGateway")(function* (): Effect.fn.Return<
  GatewayClient,
  IntegrationsCliError,
  HttpClient.HttpClient
> {
  const url = process.env["INTEGRATIONS_URL"]
  const apiKey = process.env["INTEGRATIONS_API_KEY"]
  const configured: ClientConnection | undefined =
    url !== undefined && url.length > 0 && apiKey !== undefined && apiKey.length > 0 ? { url, apiKey } : undefined
  const connection = configured ?? (yield* loggedIn()) ?? (yield* Effect.promise(() => resolveClientConnection()))
  if (connection === undefined) {
    return yield* cliError(
      "No integrations gateway configured. Run `i login --url <gateway>`, set INTEGRATIONS_URL and INTEGRATIONS_API_KEY, or start the local gateway with `ii serve`."
    )
  }
  return yield* makeGatewayClient(connection)
})

/** Who the saved login acts as on this gateway, if it still works there. */
export const savedLoginIdentity = Effect.fn("AgentLogin.identity")(function* (url: string) {
  const saved = yield* readLogin()
  if (saved?.tokens === undefined || saved.issuer !== new URL(url).origin) return Option.none<CredentialIdentity>()
  return yield* loggedIn().pipe(
    Effect.flatMap((connection) =>
      connection === undefined
        ? Effect.succeed(Option.none<CredentialIdentity>())
        : makeGatewayClient(connection).pipe(
            Effect.flatMap((client) => client.delegated.whoami()),
            Effect.map(Option.some)
          )
    ),
    Effect.orElseSucceed(() => Option.none<CredentialIdentity>())
  )
})
