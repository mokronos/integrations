import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
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
