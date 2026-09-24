import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { ConnectionName, IntegrationSlug } from "@integragents/contracts"
import { AuthTemplateSlug, OAuthClientSlug } from "../src/catalog/ids.ts"
import { McpClient } from "../src/mcp/client.ts"
import { OAuthFlows } from "../src/oauth/flows.ts"
import { OpenApiInvoker } from "../src/openapi/invoke.ts"
import { stubbedLayer } from "../src/runtime.ts"

const provider = IntegrationSlug.make("provider")
const clientSlug = OAuthClientSlug.make("provider-gateway")

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

describe("a dynamically registered client", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("authenticates the token exchange the way it registered", () =>
    Effect.gen(function*() {
      const tokenRequests: Array<Request> = []
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.url === "https://provider.test/register") {
          return Response.json({
            client_id: "client-1",
            client_secret: "secret-1",
            redirect_uris: ["https://gateway.test/callback"],
            token_endpoint_auth_method: "client_secret_post"
          })
        }
        tokenRequests.push(request)
        return Response.json({ access_token: "access-1", token_type: "Bearer" })
      })

      const oauth = yield* OAuthFlows
      yield* oauth.registerDynamicClient({
        owner: "org",
        slug: clientSlug,
        integration: provider,
        redirectUri: "https://gateway.test/callback",
        registrationEndpoint: "https://provider.test/register",
        authorizationUrl: "https://provider.test/authorize",
        tokenUrl: "https://provider.test/token",
        scopes: []
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
      yield* oauth.complete({ state: started.state, code: "code-1" })

      const [token] = tokenRequests
      const body = new URLSearchParams(yield* Effect.promise(() => token!.text()))
      expect(token!.headers.get("authorization")).toBeNull()
      expect(body.get("client_id")).toBe("client-1")
      expect(body.get("client_secret")).toBe("secret-1")
    }).pipe(Effect.provide(services)))
})
