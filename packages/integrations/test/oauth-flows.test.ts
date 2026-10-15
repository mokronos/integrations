import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { ConnectionName, IntegrationSlug } from "@integragents/contracts"
import { AuthTemplateSlug, OAuthClientSlug } from "../src/catalog/ids.ts"
import { CatalogStore } from "../src/catalog/store.ts"
import { Egress } from "../src/egress/egress.ts"
import { nativeConnect } from "../src/egress/native.ts"
import { defaultUrlPolicy } from "../src/egress/url-policy.ts"
import type { OAuthError, StorageError } from "../src/errors.ts"
import { OAuthFlows } from "../src/oauth/flows.ts"
import type { OAuthMethodSettings } from "../src/oauth/flows.ts"
import { temporarySqlLayer } from "../src/runtime.ts"
import { CredentialStore } from "../src/storage/credentials.ts"
import { Database } from "../src/storage/database.ts"
import { createEncryption } from "../src/storage/encryption.ts"
import { fakeAuthorizationServer } from "./support/oauth-server.ts"
import type { FakeAuthorizationServer, FakeAuthorizationServerOptions } from "./support/oauth-server.ts"

const integration = IntegrationSlug.make("provider")
const connection = ConnectionName.make("default")
const slug = OAuthClientSlug.make("provider-client")
const redirectUri = "https://gateway.test/v1/oauth/callback"
const grant = { owner: "org" as const, integration, connection, clientOwner: "org" as const, client: slug }

const services = OAuthFlows.layer.pipe(
  Layer.provideMerge(CatalogStore.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      Database.layer,
      CredentialStore.sqlLayer(createEncryption(new Uint8Array(32).fill(7))),
      Egress.layer(defaultUrlPolicy, nativeConnect(defaultUrlPolicy))
    )
  ),
  Layer.provide(temporarySqlLayer)
)

const withServer = <A, E>(
  options: FakeAuthorizationServerOptions,
  use: (fake: FakeAuthorizationServer) => Effect.Effect<A, E, OAuthFlows | CatalogStore>
) => Effect.scoped(Effect.flatMap(fakeAuthorizationServer(options), use)).pipe(Effect.provide(services))

const startWith = Effect.fn("startWith")(function* (settings: OAuthMethodSettings, register: boolean) {
  const oauth = yield* OAuthFlows
  const setup = yield* oauth.discover(settings)
  yield* register
    ? oauth.registerClient({ owner: "org", slug, integration, setup, redirectUri })
    : oauth.saveClient({ owner: "org", slug, integration, setup, clientId: "manual", clientSecret: "manual-secret" })
  const started = yield* oauth.start({
    owner: "org",
    clientOwner: "org",
    client: slug,
    integration,
    connection,
    template: AuthTemplateSlug.make("oauth2"),
    redirectUri
  })
  return { setup, authorization: new URL(started.authorizationUrl) }
})

const callbackFor = (authorization: URL, extra: Record<string, string> = {}) =>
  new URLSearchParams({
    code: "code-1",
    state: authorization.searchParams.get("state") ?? "",
    iss: new URL(authorization).origin,
    ...extra
  })

const connect = (fake: FakeAuthorizationServer) =>
  Effect.gen(function* () {
    const oauth = yield* OAuthFlows
    const store = yield* CatalogStore
    const { authorization } = yield* startWith({ discoveryUrl: fake.endpoint }, true)
    yield* oauth.complete(callbackFor(authorization))
    yield* store.putIntegration({
      slug: integration,
      name: "Provider",
      description: "",
      kind: "mcp",
      endpoint: fake.endpoint,
      authMethods: [],
      createdAt: 0
    })
    yield* store.putConnection({
      owner: "org",
      integration,
      name: connection,
      template: AuthTemplateSlug.make("oauth2"),
      provider: "oauth",
      oauthClient: slug,
      oauthClientOwner: "org",
      createdAt: 0
    })
  })

const reasonOf = (failure: OAuthError | StorageError): string =>
  failure._tag === "OAuthError" ? failure.reason : failure._tag

const refreshes = (fake: FakeAuthorizationServer) =>
  fake.tokenRequests.filter((request) => request.grant === "refresh_token").length

describe("discovery", () => {
  it.effect("follows the endpoint's challenge to its metadata and asks for the challenged scope", () =>
    withServer({}, (fake) =>
      Effect.gen(function* () {
        const setup = yield* (yield* OAuthFlows).discover({ discoveryUrl: fake.endpoint })
        expect({ resource: setup.resource, scopes: setup.scopes, issuer: setup.server.issuer }).toEqual({
          resource: fake.endpoint,
          scopes: ["read", "offline_access"],
          issuer: fake.origin
        })
      })
    )
  )

  it.effect("refuses metadata that claims to protect a different resource", () =>
    withServer({ resourcePath: "/elsewhere" }, (fake) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip((yield* OAuthFlows).discover({ discoveryUrl: fake.endpoint }))
        expect(reasonOf(failure)).toBe("invalid_response")
      })
    )
  )

  it.effect("never reaches a private address, configured or discovered", () =>
    Effect.gen(function* () {
      const oauth = yield* OAuthFlows
      const metadata = yield* Effect.flip(oauth.discover({ discoveryUrl: "http://169.254.169.254/latest" }))
      const configured = yield* Effect.flip(
        oauth.discover({
          authorizationUrl: "https://10.0.0.5/authorize",
          tokenUrl: "https://10.0.0.5/token"
        })
      )
      expect([metadata.reason, configured.reason]).toEqual(["destination_blocked", "destination_blocked"])
    }).pipe(Effect.provide(services))
  )
})

describe("registration and code exchange", () => {
  it.effect(
    "registers with the client authentication the server allows and uses it, even when registration answers 200",
    () =>
      withServer({ authMethods: ["client_secret_post"], registrationStatus: 200 }, (fake) =>
        Effect.gen(function* () {
          const oauth = yield* OAuthFlows
          const { authorization } = yield* startWith({ discoveryUrl: fake.endpoint }, true)
          yield* oauth.complete(callbackFor(authorization))
          const [token] = fake.tokenRequests
          expect({
            registered: fake.registrations[0]?.["token_endpoint_auth_method"],
            secretInBody: token?.body.get("client_secret"),
            authorization: token?.authorization
          }).toEqual({ registered: "client_secret_post", secretInBody: "secret-1", authorization: null })
        })
      )
  )

  it.effect("only asks for re-consent where the provider needs it for a refresh token", () =>
    withServer({}, (fake) =>
      Effect.gen(function* () {
        const { authorization: generic } = yield* startWith({ discoveryUrl: fake.endpoint }, true)
        const { authorization: google } = yield* startWith(
          {
            authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
            tokenUrl: "https://oauth2.googleapis.com/token"
          },
          false
        )
        expect([generic.searchParams.get("prompt"), google.searchParams.get("prompt")]).toEqual([null, "consent"])
      })
    )
  )

  it.effect("refuses a callback from another issuer and one carrying two states", () =>
    withServer({}, (fake) =>
      Effect.gen(function* () {
        const oauth = yield* OAuthFlows
        const first = yield* startWith({ discoveryUrl: fake.endpoint }, true)
        const forged = yield* Effect.flip(
          oauth.complete(callbackFor(first.authorization, { iss: "https://evil.test" }))
        )
        const second = yield* startWith({ discoveryUrl: fake.endpoint }, true)
        const doubled = callbackFor(second.authorization)
        doubled.append("state", "x".repeat(43))
        const ambiguous = yield* Effect.flip(oauth.complete(doubled))
        expect({
          forged: reasonOf(forged),
          ambiguous: reasonOf(ambiguous),
          exchanges: fake.tokenRequests.length
        }).toEqual({ forged: "invalid_response", ambiguous: "invalid_callback", exchanges: 0 })
      })
    )
  )

  it.effect("reports a refused exchange without the provider's own words", () =>
    withServer(
      {
        tokenFailure: { status: 400, body: { error: "invalid_grant", error_description: "leaked-detail-7781" } }
      },
      (fake) =>
        Effect.gen(function* () {
          const { authorization } = yield* startWith({ discoveryUrl: fake.endpoint }, true)
          const failure = yield* Effect.flip((yield* OAuthFlows).complete(callbackFor(authorization)))
          expect({ reason: reasonOf(failure), leaked: failure.message.includes("leaked-detail-7781") }).toEqual({
            reason: "invalid_grant",
            leaked: false
          })
        })
    )
  )

  it.effect("reads Slack's bot grant as a bearer token with space-separated scopes", () =>
    withServer({ slackEnvelope: true }, (fake) =>
      Effect.gen(function* () {
        const oauth = yield* OAuthFlows
        const { authorization } = yield* startWith({ discoveryUrl: fake.endpoint }, true)
        const completed = yield* oauth.complete(callbackFor(authorization))
        const access = yield* oauth.accessToken(grant)
        expect({ scope: Option.getOrUndefined(completed.scope), token: Option.getOrUndefined(access)?.value }).toEqual({
          scope: "chat:write channels:read",
          token: "xoxb-bot"
        })
      })
    )
  )
})

describe("refresh", () => {
  it.live("spends a rotating refresh token once, however many callers need a fresh token", () =>
    withServer({ refreshDelayMs: 150 }, (fake) =>
      Effect.gen(function* () {
        const oauth = yield* OAuthFlows
        yield* connect(fake)
        const tokens = yield* Effect.all(
          [
            oauth.accessToken(grant, { renew: true }),
            oauth.accessToken(grant, { renew: true }),
            oauth.accessToken(grant, { renew: true })
          ],
          { concurrency: "unbounded" }
        )
        const values = new Set(tokens.map((token) => Option.getOrUndefined(token)?.value))
        expect({ refreshes: refreshes(fake), distinct: values.size }).toEqual({ refreshes: 1, distinct: 1 })
      })
    )
  )

  it.effect("stops asking the provider once it refuses the grant, until someone authorizes again", () =>
    withServer({}, (fake) =>
      Effect.gen(function* () {
        const oauth = yield* OAuthFlows
        yield* connect(fake)
        fake.liveRefreshTokens.clear()
        const refused = yield* Effect.flip(oauth.accessToken(grant, { renew: true }))
        const after = yield* Effect.flip(oauth.accessToken(grant, { renew: true }))
        expect({ refused: reasonOf(refused), after: reasonOf(after), refreshes: refreshes(fake) }).toEqual({
          refused: "reconnect_required",
          after: "reconnect_required",
          refreshes: 1
        })
      })
    )
  )
})
