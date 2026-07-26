import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  connectionManagerPaths,
  createConnectionManager,
  discoverMcpOAuth
} from "../src/connections.ts"
import { authorizeMcpInBrowser } from "../src/cli/oauth.ts"

const servers: Array<ReturnType<typeof Bun.serve>> = []
const directories: Array<string> = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

const RegistrationRequest = Schema.Struct({
  redirect_uris: Schema.Array(Schema.String),
  token_endpoint_auth_method: Schema.String,
  grant_types: Schema.Array(Schema.String),
  response_types: Schema.Array(Schema.String),
  client_name: Schema.String
})

const form = async (request: Request): Promise<URLSearchParams> =>
  new URLSearchParams(await request.text())

const sha256Base64Url = (value: string): string =>
  createHash("sha256").update(value).digest("base64url")

const oauthFixture = (failRefresh = false) => {
  let registeredRedirect = ""
  let authorizationChallenge = ""
  let authorizationCount = 0
  let tokenExchangeCount = 0
  let refreshCount = 0

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      const baseUrl = `http://127.0.0.1:${server.port}`
      if (url.pathname === "/mcp") {
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer realm="test", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`
          }
        })
      }
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${baseUrl}/mcp`,
          authorization_servers: [baseUrl],
          scopes_supported: ["cases:read", "cases:write"],
          bearer_methods_supported: ["header"]
        })
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          registration_endpoint: `${baseUrl}/register`,
          scopes_supported: ["cases:read", "cases:write"],
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"]
        })
      }
      if (url.pathname === "/register") {
        const registration = await Schema.decodeUnknownPromise(RegistrationRequest)(await request.json())
        expect(registration.token_endpoint_auth_method).toBe("none")
        expect(registration.grant_types).toContain("refresh_token")
        registeredRedirect = registration.redirect_uris[0] ?? ""
        return Response.json({
          client_id: "dynamic-test-client",
          token_endpoint_auth_method: "none"
        }, { status: 201 })
      }
      if (url.pathname === "/authorize") {
        authorizationCount += 1
        expect(url.searchParams.get("client_id")).toBe("dynamic-test-client")
        expect(url.searchParams.get("redirect_uri")).toBe(registeredRedirect)
        expect(url.searchParams.get("resource")).toBe(`${baseUrl}/mcp`)
        expect(url.searchParams.get("scope")).toBe("cases:read cases:write")
        expect(url.searchParams.get("code_challenge_method")).toBe("S256")
        authorizationChallenge = url.searchParams.get("code_challenge") ?? ""
        const callback = new URL(registeredRedirect)
        callback.searchParams.set("code", "one-time-code")
        callback.searchParams.set("state", url.searchParams.get("state") ?? "")
        callback.searchParams.set("iss", baseUrl)
        return new Response(null, { status: 302, headers: { location: callback.toString() } })
      }
      if (url.pathname === "/token") {
        const body = await form(request)
        expect(body.get("client_id")).toBe("dynamic-test-client")
        expect(body.get("resource")).toBe(`${baseUrl}/mcp`)
        if (body.get("grant_type") === "authorization_code") {
          tokenExchangeCount += 1
          expect(body.get("code")).toBe("one-time-code")
          expect(body.get("redirect_uri")).toBe(registeredRedirect)
          expect(sha256Base64Url(body.get("code_verifier") ?? "")).toBe(authorizationChallenge)
          return Response.json({
            access_token: "initial-access-token",
            refresh_token: "initial-refresh-token",
            token_type: "Bearer",
            expires_in: 0,
            scope: "cases:read cases:write"
          })
        }
        expect(body.get("grant_type")).toBe("refresh_token")
        expect(body.get("refresh_token")).toBe("initial-refresh-token")
        refreshCount += 1
        if (failRefresh) {
          return Response.json({ error: "invalid_grant", error_description: "refresh token revoked" }, { status: 400 })
        }
        return Response.json({
          access_token: "rotated-access-token",
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "cases:read cases:write"
        })
      }
      return new Response("not found", { status: 404 })
    }
  })
  servers.push(server)
  return {
    resource: `http://127.0.0.1:${server.port}/mcp`,
    counts: () => ({ authorizationCount, tokenExchangeCount, refreshCount })
  }
}

describe("OAuth connections", () => {
  test("discovers, authorizes in a loopback browser, encrypts, and refreshes credentials", async () => {
    const fixture = oauthFixture()
    const directory = await mkdtemp(path.join(os.tmpdir(), "wf-connections-"))
    directories.push(directory)
    const paths = connectionManagerPaths(directory)
    const discovery = await discoverMcpOAuth(fixture.resource)
    expect(discovery.resourceMetadata.resource).toBe(fixture.resource)
    expect(discovery.authorizationServerMetadata.registration_endpoint).toContain("/register")

    const manager = createConnectionManager(paths)
    const connection = await authorizeMcpInBrowser({
      manager,
      connectionId: "case_manager_oauth",
      resource: fixture.resource,
      scopes: ["cases:read", "cases:write"],
      open: async (authorizationUrl) => {
        const authorization = await fetch(authorizationUrl, { redirect: "manual" })
        const callback = authorization.headers.get("location")
        expect(callback).not.toBeNull()
        const callbackResponse = await fetch(callback ?? "")
        expect(callbackResponse.status).toBe(200)
        expect(await callbackResponse.text()).toContain("Account connected")
      }
    })

    expect(String(connection.id)).toBe("case_manager_oauth")
    expect(manager.list()).toEqual([connection])
    expect(manager.list()[0]).not.toHaveProperty("accessToken")
    const resolver = manager.secretResolver()
    await expect(resolver.resolve("case_manager_oauth")).rejects.toThrow("authorized resource")
    await expect(resolver.resolve("case_manager_oauth", { resource: "https://attacker.example/mcp" })).rejects.toThrow("not https://attacker.example/mcp")
    expect(await resolver.resolve("case_manager_oauth", { resource: fixture.resource })).toBe("rotated-access-token")
    expect(fixture.counts()).toEqual({ authorizationCount: 1, tokenExchangeCount: 1, refreshCount: 1 })

    const files = await readdir(directory)
    const stored = Buffer.concat(await Promise.all(files.map((file) => readFile(path.join(directory, file)))))
      .toString("utf8")
    for (const secret of [
      "one-time-code",
      "initial-access-token",
      "initial-refresh-token",
      "rotated-access-token",
      "rotated-refresh-token"
    ]) {
      expect(stored).not.toContain(secret)
    }
    expect((await stat(paths.keyPath)).mode & 0o777).toBe(0o600)
  })

  test("rejects altered state and callback replay before another token exchange", async () => {
    const fixture = oauthFixture()
    const directory = await mkdtemp(path.join(os.tmpdir(), "wf-connections-state-"))
    directories.push(directory)
    const manager = createConnectionManager(connectionManagerPaths(directory))
    const attempt = await manager.beginMcpOAuth({
      connectionId: "state_test",
      resource: fixture.resource,
      redirectUri: "http://127.0.0.1:43119/oauth/callback",
      scopes: ["cases:read", "cases:write"]
    })
    const authorization = await fetch(attempt.authorizationUrl, { redirect: "manual" })
    const callbackValue = authorization.headers.get("location")
    expect(callbackValue).not.toBeNull()
    const callback = new URL(callbackValue ?? "")
    const altered = new URL(callback)
    altered.searchParams.set("state", "attacker-state")

    await expect(attempt.complete(altered.toString())).rejects.toThrow("state did not match")
    expect(fixture.counts().tokenExchangeCount).toBe(0)
    await expect(attempt.complete(callback.toString())).resolves.toMatchObject({ status: "active" })
    await expect(attempt.complete(callback.toString())).rejects.toThrow("already consumed")
    expect(fixture.counts().tokenExchangeCount).toBe(1)
  })

  test("marks a revoked refresh token as requiring reauthorization", async () => {
    const fixture = oauthFixture(true)
    const directory = await mkdtemp(path.join(os.tmpdir(), "wf-connections-revoked-"))
    directories.push(directory)
    const manager = createConnectionManager(connectionManagerPaths(directory))
    const attempt = await manager.beginMcpOAuth({
      connectionId: "revoked_connection",
      resource: fixture.resource,
      redirectUri: "http://127.0.0.1:43120/oauth/callback",
      scopes: ["cases:read", "cases:write"]
    })
    const authorization = await fetch(attempt.authorizationUrl, { redirect: "manual" })
    await attempt.complete(authorization.headers.get("location") ?? "")

    await expect(manager.secretResolver().resolve(
      "revoked_connection",
      { resource: fixture.resource }
    )).rejects.toThrow("must be authorized again")
    expect(manager.get("revoked_connection")?.status).toBe("reauthorization-required")
  })
})
