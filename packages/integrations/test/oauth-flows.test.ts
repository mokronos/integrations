import { createServer } from "node:http"
import type { Server } from "node:http"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { ConnectionName, IntegrationSlug } from "@integragents/contracts"
import { AuthTemplateSlug, OAuthClientSlug } from "../src/catalog/ids.ts"
import { McpClient } from "../src/mcp/client.ts"
import { OAuthFlows } from "../src/oauth/flows.ts"
import { OpenApiInvoker } from "../src/openapi/invoke.ts"
import { stubbedLayer } from "../src/runtime.ts"

const provider = IntegrationSlug.make("provider")
const clientSlug = OAuthClientSlug.make("provider-wf")

const unusedMcp = Layer.effect(
  McpClient,
  Effect.sync(() => {
    const unused = (method: string) => () => Effect.die(new Error(`McpClient.${method}`))
    return {
      probe: unused("probe"),
      listTools: unused("listTools"),
      callTool: unused("callTool")
    }
  })
)

const services = stubbedLayer(Layer.mergeAll(unusedMcp, OpenApiInvoker.unavailableTestLayer))

const authorize = Effect.fn("authorize")(function* (scopes: ReadonlyArray<string>) {
  const oauth = yield* OAuthFlows
  yield* oauth.createClient({
    owner: "org",
    slug: clientSlug,
    integration: provider,
    authorizationUrl: "https://provider.test/authorize",
    tokenUrl: "https://provider.test/token",
    clientId: "client-1",
    scopes
  })
  const started = yield* oauth.start({
    owner: "org",
    clientOwner: "org",
    client: clientSlug,
    integration: provider,
    connection: ConnectionName.make("default"),
    template: AuthTemplateSlug.make("oauth"),
    redirectUri: "https://gateway.test/callback"
  })
  return new URL(started.authorizationUrl).searchParams
})

describe("the authorization request", () => {
  it.effect("asks for offline access in every dialect a provider might speak", () =>
    Effect.gen(function*() {
      const params = yield* authorize(["read"])
      expect(params.get("access_type")).toBe("offline")
      expect(params.get("token_access_type")).toBe("offline")
      expect(params.get("prompt")).toBe("consent")
    }).pipe(Effect.provide(services)))

  it.effect("names consent once when the scope already implies offline access", () =>
    Effect.gen(function*() {
      const params = yield* authorize(["read", "offline_access"])
      expect(params.getAll("prompt")).toEqual(["consent"])
    }).pipe(Effect.provide(services)))
})

const registeredSecret = "registered-secret"

const decodeListening = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))

const postOnlyAuthorizationServer = Effect.acquireRelease(
  Effect.promise(() =>
    new Promise<{ readonly url: string; readonly server: Server }>((resolve) => {
      const server = createServer((request, response) => {
        const chunks: Array<Buffer> = []
        request.on("data", (chunk: Buffer) => chunks.push(chunk))
        request.on("end", () => {
          const body = Buffer.concat(chunks).toString()
          response.setHeader("content-type", "application/json")
          if (request.url === "/register") {
            response.statusCode = 201
            response.end(JSON.stringify({
              ...JSON.parse(body),
              client_id: "registered-client",
              client_secret: registeredSecret,
              token_endpoint_auth_method: "client_secret_post"
            }))
            return
          }
          if (new URLSearchParams(body).get("client_secret") !== registeredSecret) {
            response.statusCode = 401
            response.end(JSON.stringify({ error: "invalid_client" }))
            return
          }
          response.end(JSON.stringify({ access_token: "access", token_type: "Bearer" }))
        })
      })
      server.listen(0, "127.0.0.1", () => {
        const { port } = decodeListening(server.address())
        resolve({ url: `http://127.0.0.1:${port}`, server })
      })
    })
  ),
  ({ server }) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
)

describe("the token exchange", () => {
  it.effect("authenticates the way the client was registered, not the server's first preference", () =>
    Effect.gen(function*() {
      const { url } = yield* postOnlyAuthorizationServer
      const oauth = yield* OAuthFlows
      yield* oauth.registerDynamicClient({
        owner: "org",
        slug: clientSlug,
        integration: provider,
        redirectUri: "https://gateway.test/callback",
        registrationEndpoint: `${url}/register`,
        authorizationUrl: `${url}/authorize`,
        tokenUrl: `${url}/token`,
        scopes: [],
        tokenAuthMethods: ["client_secret_basic", "client_secret_post"]
      })
      const started = yield* oauth.start({
        owner: "org",
        clientOwner: "org",
        client: clientSlug,
        integration: provider,
        connection: ConnectionName.make("default"),
        template: AuthTemplateSlug.make("oauth"),
        redirectUri: "https://gateway.test/callback"
      })
      const completed = yield* oauth.complete({ state: started.state, code: "code" })
      expect(completed.client).toBe(clientSlug)
    }).pipe(Effect.scoped, Effect.provide(services)))
})
