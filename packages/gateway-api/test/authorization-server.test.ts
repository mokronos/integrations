import { makeGatewayEvents } from "@integragents/gateway-core"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import {
  createGatewayHandler,
  defaultTenantId,
  generateApiKey,
  newProfileId,
  sha256Base64Url,
  SubjectId
} from "./gateway.ts"
import { gatewayStore, testServices } from "./fixtures.ts"
import { OAuthConsentDecision } from "@integragents/contracts"
import { stubIntegrationsContext } from "./stubs.ts"

const JsonObject = Schema.Record(Schema.String, Schema.Json)
const Registration = Schema.Struct({ client_id: Schema.String })
const Consent = Schema.Struct({
  application: Schema.Struct({ name: Schema.String, kind: Schema.Literals(["cimd", "dcr"]) }),
  profiles: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))
})
const Redirect = Schema.Struct({ redirect: Schema.String })
const DeviceAuthorization = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.String,
  interval: Schema.Number
})
const OAuthFailure = Schema.Struct({ error: Schema.String })
const Grants = Schema.Struct({
  grants: Schema.Array(Schema.Struct({ id: Schema.String, subjectEmail: Schema.String }))
})
const Revocation = Schema.Struct({ revoked: Schema.Boolean })
const Tokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Number,
  scope: Schema.Literal("mcp offline_access")
})

const setup = Effect.fnUntraced(function* (httpClient: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer) {
  const store = yield* gatewayStore("gateway-mcp-oauth-")
  const profile = yield* store.createProfile({
    id: yield* newProfileId,
    tenantId: defaultTenantId,
    name: "Local OAuth profile",
    capabilities: [],
    tools: []
  })
  const key = yield* generateApiKey
  yield* store.addApiKey({ id: key.id, profileId: profile.id, name: "This machine", hash: key.hash })
  const gateway = createGatewayHandler({
    events: yield* makeGatewayEvents,
    store,
    integrationServices: stubIntegrationsContext(),
    httpClient,
    retentionDays: 30,
    mcpUrl: () => "http://127.0.0.1:3210/mcp",
    oauth: {
      start: () => Effect.die(new Error("not used")),
      provideClient: () => Effect.sync((): undefined => undefined),
      get: () => Effect.sync((): undefined => undefined),
      completeByState: () => Effect.sync((): undefined => undefined),
      stop: () => Effect.void
    }
  })
  return { ...gateway, store, profile, key }
})

const request = (
  handle: (request: Request, context?: { readonly localSecret?: string }) => Promise<Response>,
  path: string,
  init?: RequestInit,
  localSecret?: string
) =>
  Effect.promise(() =>
    handle(new Request(`http://127.0.0.1:3210${path}`, init), localSecret === undefined ? undefined : { localSecret })
  )

const cimdAuthorization = (clientIdentifier: string) =>
  Effect.gen(function* () {
    const authorize = new URL("http://127.0.0.1:3210/oauth/authorize")
    authorize.searchParams.set("response_type", "code")
    authorize.searchParams.set("client_id", clientIdentifier)
    authorize.searchParams.set("redirect_uri", "http://127.0.0.1:9876/callback")
    authorize.searchParams.set("resource", "http://127.0.0.1:3210/mcp")
    authorize.searchParams.set("scope", "mcp offline_access")
    authorize.searchParams.set(
      "code_challenge",
      yield* sha256Base64Url("client-id-metadata-document-verifier-0123456789")
    )
    authorize.searchParams.set("code_challenge_method", "S256")
    return new Request(authorize)
  })

describe("MCP OAuth authorization server", () => {
  it.effect("never fetches client metadata from a private address", () =>
    Effect.gen(function* () {
      const fetched: Array<string> = []
      const httpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          fetched.push(request.url)
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})))
        })
      )
      const gateway = yield* setup(httpClient)
      for (const clientIdentifier of [
        "https://169.254.169.254/latest/meta-data",
        "https://[fd00::1]/client.json",
        "https://100.64.0.1/client.json",
        "https://metadata.internal/client.json",
        "https://localhost/client.json"
      ]) {
        const authorization = yield* Effect.flatMap(cimdAuthorization(clientIdentifier), (request) =>
          Effect.promise(() => gateway.handle(request))
        )
        expect(authorization.status).toBe(400)
      }
      expect(fetched).toEqual([])
      yield* Effect.promise(() => gateway.dispose())
    }).pipe(Effect.provide(testServices))
  )

  it.effect("refuses client metadata larger than 64 KiB even without a content-length", () =>
    Effect.gen(function* () {
      const clientIdentifier = "https://client.example/oauth/metadata.json"
      const document = JSON.stringify({
        client_id: clientIdentifier,
        client_name: "x".repeat(70 * 1024),
        redirect_uris: ["http://127.0.0.1/callback"]
      })
      const httpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(new Blob([document]).stream(), { headers: { "content-type": "application/json" } })
            )
          )
        )
      )
      const gateway = yield* setup(httpClient)
      const authorization = yield* Effect.flatMap(cimdAuthorization(clientIdentifier), (request) =>
        Effect.promise(() => gateway.handle(request))
      )
      expect(authorization.status).toBe(400)
      expect(yield* gateway.store.findOAuthApplication(clientIdentifier)).toBeUndefined()
      yield* Effect.promise(() => gateway.dispose())
    }).pipe(Effect.provide(testServices))
  )

  it.effect("treats a client ID metadata document as the primary registration path", () =>
    Effect.gen(function* () {
      const clientIdentifier = "https://client.example/oauth/metadata.json"
      const httpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                client_id: clientIdentifier,
                client_name: "CIMD application",
                redirect_uris: ["http://127.0.0.1/callback"],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none"
              })
            )
          )
        )
      )
      const gateway = yield* setup(httpClient)
      const verifier = "client-id-metadata-document-verifier-0123456789"
      const authorize = new URL("http://127.0.0.1:3210/oauth/authorize")
      authorize.searchParams.set("response_type", "code")
      authorize.searchParams.set("client_id", clientIdentifier)
      authorize.searchParams.set("redirect_uri", "http://127.0.0.1:9876/callback")
      authorize.searchParams.set("resource", "http://127.0.0.1:3210/mcp")
      authorize.searchParams.set("scope", "mcp")
      authorize.searchParams.set("code_challenge", yield* sha256Base64Url(verifier))
      authorize.searchParams.set("code_challenge_method", "S256")

      const authorization = yield* Effect.promise(() => gateway.handle(new Request(authorize)))
      expect(authorization.status).toBe(302)
      const pendingId = new URL(authorization.headers.get("location") ?? "").searchParams.get("request") ?? ""
      const consent = yield* request(
        gateway.handle,
        `/v1/oauth/authorization-request?id=${encodeURIComponent(pendingId)}`,
        undefined,
        gateway.key.secret
      )
      const consentBody = Schema.decodeUnknownSync(Consent)(yield* Effect.promise(() => consent.json()))
      expect(consentBody.application).toEqual({ name: "CIMD application", kind: "cimd" })
      yield* Effect.promise(() => gateway.dispose())
    }).pipe(Effect.provide(testServices))
  )

  it.effect("discovers, authorizes locally, rotates tokens, and revokes the grant", () =>
    Effect.gen(function* () {
      const gateway = yield* setup()

      const protectedMetadata = yield* request(gateway.handle, "/.well-known/oauth-protected-resource/mcp")
      expect(protectedMetadata.status).toBe(200)
      const protectedBody = Schema.decodeUnknownSync(JsonObject)(yield* Effect.promise(() => protectedMetadata.json()))
      expect(protectedBody["resource"]).toBe("http://127.0.0.1:3210/mcp")
      expect(protectedBody["authorization_servers"]).toEqual(["http://127.0.0.1:3210"])
      expect(protectedBody["scopes_supported"]).toEqual(["mcp", "offline_access"])
      const challenged = yield* request(gateway.handle, "/mcp", { method: "POST" })
      expect(challenged.headers.get("www-authenticate")).toContain(`scope="mcp offline_access"`)

      const serverMetadata = yield* request(gateway.handle, "/.well-known/oauth-authorization-server")
      const serverBody = Schema.decodeUnknownSync(JsonObject)(yield* Effect.promise(() => serverMetadata.json()))
      expect(serverBody["client_id_metadata_document_supported"]).toBe(true)
      expect(serverBody["registration_endpoint"]).toBe("http://127.0.0.1:3210/oauth/register")
      expect(serverBody["scopes_supported"]).toEqual(["mcp", "offline_access"])

      const registered = yield* request(gateway.handle, "/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Claude-compatible test client",
          redirect_uris: ["http://127.0.0.1:4567/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none"
        })
      })
      expect(registered.status).toBe(201)
      const application = Schema.decodeUnknownSync(Registration)(yield* Effect.promise(() => registered.json()))

      const verifier = "correct-horse-battery-staple-verifier-0123456789"
      const challenge = yield* sha256Base64Url(verifier)
      const authorize = new URL("http://127.0.0.1:3210/oauth/authorize")
      authorize.searchParams.set("response_type", "code")
      authorize.searchParams.set("client_id", application.client_id)
      authorize.searchParams.set("redirect_uri", "http://127.0.0.1:4567/callback")
      authorize.searchParams.set("resource", "http://127.0.0.1:3210/mcp")
      authorize.searchParams.set("scope", "offline_access mcp")
      authorize.searchParams.set("state", "test-state")
      authorize.searchParams.set("code_challenge", challenge)
      authorize.searchParams.set("code_challenge_method", "S256")
      const authorization = yield* Effect.promise(() => gateway.handle(new Request(authorize)))
      expect(authorization.status).toBe(302)
      const consentUrl = new URL(authorization.headers.get("location") ?? "")
      const authorizationRequestId = consentUrl.searchParams.get("request") ?? ""

      const consent = yield* request(
        gateway.handle,
        `/v1/oauth/authorization-request?id=${encodeURIComponent(authorizationRequestId)}`,
        undefined,
        gateway.key.secret
      )
      expect(consent.status).toBe(200)
      const consentBody = Schema.decodeUnknownSync(Consent)(yield* Effect.promise(() => consent.json()))
      expect(consentBody.application).toEqual({ name: "Claude-compatible test client", kind: "dcr" })
      expect(consentBody.profiles.map((entry) => entry.id)).toContain(gateway.profile.id)

      const approved = yield* request(
        gateway.handle,
        `/v1/oauth/authorization-request?id=${encodeURIComponent(authorizationRequestId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:3210" },
          body: JSON.stringify({ decision: "approve", profileId: gateway.profile.id })
        },
        gateway.key.secret
      )
      expect(approved.status).toBe(200)
      const approvedBody = Schema.decodeUnknownSync(Redirect)(yield* Effect.promise(() => approved.json()))
      const callback = new URL(approvedBody.redirect)
      expect(callback.searchParams.get("state")).toBe("test-state")
      expect(callback.searchParams.get("iss")).toBe("http://127.0.0.1:3210")

      const exchange = (form: URLSearchParams) =>
        request(gateway.handle, "/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form.toString()
        })
      const tokenResponse = yield* exchange(
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: application.client_id,
          code: callback.searchParams.get("code") ?? "",
          code_verifier: verifier,
          redirect_uri: "http://127.0.0.1:4567/callback",
          resource: "http://127.0.0.1:3210/mcp"
        })
      )
      expect(tokenResponse.status).toBe(200)
      const tokens = Schema.decodeUnknownSync(Tokens)(yield* Effect.promise(() => tokenResponse.json()))

      const mcpWithAccess = yield* request(gateway.handle, "/mcp", {
        method: "GET",
        headers: { authorization: `Bearer ${tokens.access_token}` }
      })
      expect(mcpWithAccess.status).not.toBe(401)
      const restWithAccess = yield* request(gateway.handle, "/v1/profiles", {
        headers: { authorization: `Bearer ${tokens.access_token}` }
      })
      expect(restWithAccess.status).toBe(401)

      const refreshResponse = yield* exchange(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: application.client_id,
          refresh_token: tokens.refresh_token,
          resource: "http://127.0.0.1:3210/mcp"
        })
      )
      expect(refreshResponse.status).toBe(200)
      const rotated = Schema.decodeUnknownSync(Tokens)(yield* Effect.promise(() => refreshResponse.json()))

      const reuse = yield* exchange(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: application.client_id,
          refresh_token: tokens.refresh_token,
          resource: "http://127.0.0.1:3210/mcp"
        })
      )
      expect(reuse.status).toBe(400)
      const invalidatedFamily = yield* request(gateway.handle, "/mcp", {
        method: "GET",
        headers: { authorization: `Bearer ${rotated.access_token}` }
      })
      expect(invalidatedFamily.status).toBe(401)

      const listed = yield* request(gateway.handle, "/v1/oauth/grants", undefined, gateway.key.secret)
      expect(listed.status).toBe(200)
      const { grants } = Schema.decodeUnknownSync(Grants)(yield* Effect.promise(() => listed.json()))
      expect(grants).toHaveLength(1)
      expect(grants[0]?.subjectEmail).toBe("Local operator")
      const revocation = yield* request(
        gateway.handle,
        `/v1/oauth/grants/${encodeURIComponent(grants[0]?.id ?? "")}`,
        { method: "DELETE" },
        gateway.key.secret
      )
      expect(Schema.decodeUnknownSync(Revocation)(yield* Effect.promise(() => revocation.json()))).toEqual({
        revoked: true
      })
      const revoked = yield* request(gateway.handle, "/mcp", {
        method: "GET",
        headers: { authorization: `Bearer ${tokens.access_token}` }
      })
      expect(revoked.status).toBe(401)

      yield* Effect.promise(() => gateway.dispose())
    }).pipe(Effect.provide(testServices))
  )

  it.effect("lets a device act as a profile on the API once a person confirms its code", () =>
    Effect.gen(function* () {
      const gateway = yield* setup()
      const post = (path: string, form: Record<string, string>) =>
        request(gateway.handle, path, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(form).toString()
        })
      const body = <A>(schema: Schema.Codec<A>, response: Response) =>
        Effect.map(
          Effect.promise(() => response.json()),
          (json) => Schema.decodeUnknownSync(schema)(json)
        )

      const registered = yield* request(gateway.handle, "/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "i on a sandbox",
          grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
          token_endpoint_auth_method: "none"
        })
      })
      expect(registered.status).toBe(201)
      const { client_id } = yield* body(Registration, registered)
      const api = "http://127.0.0.1:3210"
      const start = () => post("/oauth/device_authorization", { client_id, resource: api, scope: "mcp offline_access" })
      const poll = (deviceCode: string) =>
        post("/oauth/token", {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id,
          resource: api
        })
      const decide = (userCode: string, decision: typeof OAuthConsentDecision.Encoded) =>
        request(
          gateway.handle,
          `/v1/oauth/device-request?code=${encodeURIComponent(userCode)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json", origin: api },
            body: JSON.stringify(decision)
          },
          gateway.key.secret
        )

      const device = yield* body(DeviceAuthorization, yield* start())
      expect(device.verification_uri_complete).toBe(
        `${device.verification_uri}?user_code=${encodeURIComponent(device.user_code)}`
      )
      expect(yield* body(OAuthFailure, yield* poll(device.device_code))).toEqual({ error: "authorization_pending" })

      const typed = device.user_code.replace("-", "").toLowerCase()
      const consent = yield* request(
        gateway.handle,
        `/v1/oauth/device-request?code=${typed}`,
        undefined,
        gateway.key.secret
      )
      expect((yield* body(Consent, consent)).application).toEqual({ name: "i on a sandbox", kind: "dcr" })
      expect((yield* decide(typed, { decision: "approve", profileId: gateway.profile.id })).status).toBe(200)

      const tokens = yield* body(Tokens, yield* poll(device.device_code))
      expect(yield* body(OAuthFailure, yield* poll(device.device_code))).toEqual({ error: "invalid_grant" })
      const bearer = { headers: { authorization: `Bearer ${tokens.access_token}` } }
      expect((yield* request(gateway.handle, "/v1/tools", bearer)).status).toBe(200)
      expect((yield* request(gateway.handle, "/v1/profiles", bearer)).status).toBe(403)
      expect((yield* request(gateway.handle, "/mcp", { method: "GET", ...bearer })).status).toBe(401)

      const refused = yield* body(DeviceAuthorization, yield* start())
      expect((yield* decide(refused.user_code, { decision: "deny" })).status).toBe(200)
      expect(yield* body(OAuthFailure, yield* poll(refused.device_code))).toEqual({ error: "access_denied" })

      yield* Effect.promise(() => gateway.dispose())
    }).pipe(Effect.provide(testServices))
  )

  it.effect("offers a person only the profiles that act for them", () =>
    Effect.gen(function* () {
      const gateway = yield* setup()
      const restricted = yield* gateway.store.createProfile({
        id: yield* newProfileId,
        tenantId: defaultTenantId,
        name: "alice-only",
        capabilities: [],
        tools: [],
        subjects: [SubjectId.make("alice")]
      })
      const registered = yield* request(gateway.handle, "/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "i",
          grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]
        })
      })
      const { client_id } = Schema.decodeUnknownSync(Registration)(yield* Effect.promise(() => registered.json()))
      const started = yield* request(gateway.handle, "/oauth/device_authorization", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id, resource: "http://127.0.0.1:3210" }).toString()
      })
      const device = Schema.decodeUnknownSync(DeviceAuthorization)(yield* Effect.promise(() => started.json()))
      const path = `/v1/oauth/device-request?code=${device.user_code}`

      const consent = yield* request(gateway.handle, path, undefined, gateway.key.secret)
      const offered = Schema.decodeUnknownSync(Consent)(yield* Effect.promise(() => consent.json())).profiles
      expect(offered.map((profile) => profile.id)).toEqual([gateway.profile.id])
      const approved = yield* request(
        gateway.handle,
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve", profileId: restricted.id })
        },
        gateway.key.secret
      )
      expect(approved.status).toBe(400)
      yield* Effect.promise(() => gateway.dispose())
    }).pipe(Effect.provide(testServices))
  )

  it.effect("keeps browser clients out of the device grant", () =>
    Effect.gen(function* () {
      const gateway = yield* setup()
      const registered = yield* request(gateway.handle, "/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Browser client", redirect_uris: ["http://127.0.0.1:4567/callback"] })
      })
      const { client_id } = Schema.decodeUnknownSync(Registration)(yield* Effect.promise(() => registered.json()))
      const started = yield* request(gateway.handle, "/oauth/device_authorization", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id, resource: "http://127.0.0.1:3210" }).toString()
      })
      expect(started.status).toBe(400)
      expect(Schema.decodeUnknownSync(OAuthFailure)(yield* Effect.promise(() => started.json()))).toEqual({
        error: "invalid_client"
      })
      yield* Effect.promise(() => gateway.dispose())
    }).pipe(Effect.provide(testServices))
  )
})
