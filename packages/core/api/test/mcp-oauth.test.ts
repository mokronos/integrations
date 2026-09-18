import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import {
  createGatewayHandler,
  defaultTenantId,
  generateApiKey,
  newAccessProfileId,
  newApprovalPolicyId,
  newClientId,
  sha256Base64Url
} from "./gateway.ts"
import { gatewayStore, testServices } from "./fixtures.ts"
import { stubIntegrationsContext } from "./stubs.ts"

const JsonObject = Schema.Record(Schema.String, Schema.Json)
const Registration = Schema.Struct({ client_id: Schema.String })
const Consent = Schema.Struct({
  application: Schema.Struct({ name: Schema.String, kind: Schema.Literals(["cimd", "dcr"]) }),
  clients: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))
})
const Redirect = Schema.Struct({ redirect: Schema.String })
const Tokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Number,
  scope: Schema.Literal("mcp")
})

const setup = Effect.fnUntraced(function*(httpClient: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer) {
  const store = yield* gatewayStore("gateway-mcp-oauth-")
  const accessProfile = yield* store.createAccessProfile({
    id: yield* newAccessProfileId,
    tenantId: defaultTenantId,
    name: "oauth-access"
  })
  const approvalPolicy = yield* store.createApprovalPolicy({
    id: yield* newApprovalPolicyId,
    tenantId: defaultTenantId,
    name: "oauth-policy",
    tools: []
  })
  const client = yield* store.createClient({
    id: yield* newClientId,
    tenantId: defaultTenantId,
    accessProfileId: accessProfile.id,
    approvalPolicyId: approvalPolicy.id,
    name: "Local OAuth client",
    capabilities: []
  })
  const key = yield* generateApiKey
  yield* store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash })
  const gateway = createGatewayHandler({
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
  return { ...gateway, store, client, key }
})

const request = (
  handle: (request: Request, context?: { readonly localSecret?: string }) => Promise<Response>,
  path: string,
  init?: RequestInit,
  localSecret?: string
) => Effect.promise(() => handle(
  new Request(`http://127.0.0.1:3210${path}`, init),
  localSecret === undefined ? undefined : { localSecret }
))

describe("MCP OAuth authorization server", () => {
  it.effect("treats a client ID metadata document as the primary registration path", () =>
    Effect.gen(function*() {
      const clientIdentifier = "https://client.example/oauth/metadata.json"
      const httpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({
          client_id: clientIdentifier,
          client_name: "CIMD application",
          redirect_uris: ["http://127.0.0.1:9876/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none"
        }))))
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
    }).pipe(Effect.provide(testServices)))

  it.effect("discovers, authorizes locally, rotates tokens, and revokes the grant", () =>
    Effect.gen(function*() {
      const gateway = yield* setup()

      const protectedMetadata = yield* request(gateway.handle, "/.well-known/oauth-protected-resource/mcp")
      expect(protectedMetadata.status).toBe(200)
      const protectedBody = Schema.decodeUnknownSync(JsonObject)(yield* Effect.promise(() => protectedMetadata.json()))
      expect(protectedBody["resource"]).toBe("http://127.0.0.1:3210/mcp")
      expect(protectedBody["authorization_servers"]).toEqual(["http://127.0.0.1:3210"])

      const serverMetadata = yield* request(gateway.handle, "/.well-known/oauth-authorization-server")
      const serverBody = Schema.decodeUnknownSync(JsonObject)(yield* Effect.promise(() => serverMetadata.json()))
      expect(serverBody["client_id_metadata_document_supported"]).toBe(true)
      expect(serverBody["registration_endpoint"]).toBe("http://127.0.0.1:3210/oauth/register")

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
      authorize.searchParams.set("scope", "mcp")
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
      expect(consentBody.clients.map((entry) => entry.id)).toContain(gateway.client.id)

      const approved = yield* request(
        gateway.handle,
        `/v1/oauth/authorization-request?id=${encodeURIComponent(authorizationRequestId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:3210" },
          body: JSON.stringify({ decision: "approve", clientId: gateway.client.id })
        },
        gateway.key.secret
      )
      expect(approved.status).toBe(200)
      const approvedBody = Schema.decodeUnknownSync(Redirect)(yield* Effect.promise(() => approved.json()))
      const callback = new URL(approvedBody.redirect)
      expect(callback.searchParams.get("state")).toBe("test-state")
      expect(callback.searchParams.get("iss")).toBe("http://127.0.0.1:3210")

      const exchange = (form: URLSearchParams) => request(gateway.handle, "/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString()
      })
      const tokenResponse = yield* exchange(new URLSearchParams({
        grant_type: "authorization_code",
        client_id: application.client_id,
        code: callback.searchParams.get("code") ?? "",
        code_verifier: verifier,
        redirect_uri: "http://127.0.0.1:4567/callback",
        resource: "http://127.0.0.1:3210/mcp"
      }))
      expect(tokenResponse.status).toBe(200)
      const tokens = Schema.decodeUnknownSync(Tokens)(yield* Effect.promise(() => tokenResponse.json()))

      const mcpWithAccess = yield* request(gateway.handle, "/mcp", {
        method: "GET",
        headers: { authorization: `Bearer ${tokens.access_token}` }
      })
      expect(mcpWithAccess.status).not.toBe(401)
      const restWithAccess = yield* request(gateway.handle, "/v1/clients", {
        headers: { authorization: `Bearer ${tokens.access_token}` }
      })
      expect(restWithAccess.status).toBe(401)

      const refreshResponse = yield* exchange(new URLSearchParams({
        grant_type: "refresh_token",
        client_id: application.client_id,
        refresh_token: tokens.refresh_token,
        resource: "http://127.0.0.1:3210/mcp"
      }))
      expect(refreshResponse.status).toBe(200)
      const rotated = Schema.decodeUnknownSync(Tokens)(yield* Effect.promise(() => refreshResponse.json()))

      const reuse = yield* exchange(new URLSearchParams({
        grant_type: "refresh_token",
        client_id: application.client_id,
        refresh_token: tokens.refresh_token,
        resource: "http://127.0.0.1:3210/mcp"
      }))
      expect(reuse.status).toBe(400)
      const invalidatedFamily = yield* request(gateway.handle, "/mcp", {
        method: "GET",
        headers: { authorization: `Bearer ${rotated.access_token}` }
      })
      expect(invalidatedFamily.status).toBe(401)

      const grants = yield* gateway.store.listOAuthGrants(defaultTenantId)
      expect(grants).toHaveLength(1)
      expect(grants[0]?.subjectEmail).toBe("Local operator")
      expect(yield* gateway.store.revokeOAuthGrant(defaultTenantId, grants[0]!.id)).toBe(true)
      const revoked = yield* request(gateway.handle, "/mcp", {
        method: "GET",
        headers: { authorization: `Bearer ${tokens.access_token}` }
      })
      expect(revoked.status).toBe(401)

      yield* Effect.promise(() => gateway.dispose())
    }).pipe(Effect.provide(testServices)))
})
