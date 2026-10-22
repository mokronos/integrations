import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { AuthMethod } from "@integragents/contracts"
import { BlobStore, defaultUrlPolicy, Egress, integrationLayer, temporarySqlLayer } from "@integragents/integrations"
import { nativeConnect } from "@integragents/integrations/native-egress"
import { fakeAuthorizationServer } from "@integragents/integrations/test-oauth-server"
import type {
  FakeAuthorizationServer,
  FakeAuthorizationServerOptions
} from "@integragents/integrations/test-oauth-server"
import { prepareFlow } from "../src/connection-oauth/flows.ts"
import { testEncryption } from "./fixtures.ts"

const services = integrationLayer({ encryption: testEncryption, blobs: BlobStore.sqlLayer }).pipe(
  Layer.provideMerge(Egress.layer(defaultUrlPolicy, nativeConnect(defaultUrlPolicy))),
  Layer.provide(temporarySqlLayer)
)

const oauthMethod = (fake: FakeAuthorizationServer): AuthMethod => ({
  id: "oauth2",
  label: "OAuth",
  kind: "oauth",
  template: "oauth2",
  oauth: { discoveryUrl: fake.endpoint }
})

const withServer = <A, E, R>(
  options: FakeAuthorizationServerOptions,
  use: (fake: FakeAuthorizationServer) => Effect.Effect<A, E, R>
) => Effect.scoped(Effect.flatMap(fakeAuthorizationServer(options), use))

const prepare = (fake: FakeAuthorizationServer, redirectUri: string, publicUrl?: string) =>
  prepareFlow(
    { integration: "provider", connection: "default", authMethod: oauthMethod(fake) },
    redirectUri,
    publicUrl
  ).pipe(
    Effect.map((prepared) =>
      prepared.status === "pending" ? new URL(prepared.authorizationUrl).searchParams.get("client_id") : null
    )
  )

describe("choosing the OAuth client", () => {
  it.effect("registers once per redirect and reuses that client for the same redirect", () =>
    withServer({}, (fake) =>
      Effect.gen(function* () {
        const first = yield* prepare(fake, "http://127.0.0.1:4100/oauth/callback")
        const again = yield* prepare(fake, "http://127.0.0.1:4100/oauth/callback")
        const elsewhere = yield* prepare(fake, "http://127.0.0.1:4200/oauth/callback")
        expect({
          registrations: fake.registrations.map((registration) => registration["redirect_uris"]),
          reused: first === again,
          distinct: first !== elsewhere
        }).toEqual({
          registrations: [["http://127.0.0.1:4100/oauth/callback"], ["http://127.0.0.1:4200/oauth/callback"]],
          reused: true,
          distinct: true
        })
      })
    ).pipe(Effect.provide(services))
  )

  it.effect("uses its client metadata document instead of registering where the server accepts one", () =>
    withServer({ cimd: true }, (fake) =>
      Effect.gen(function* () {
        const clientId = yield* prepare(fake, "https://gateway.example/v1/oauth/callback", "https://gateway.example")
        expect({ clientId, registrations: fake.registrations.length }).toEqual({
          clientId: "https://gateway.example/v1/oauth/client-metadata.json",
          registrations: 0
        })
      })
    ).pipe(Effect.provide(services))
  )

  it.effect("registers when the redirect is a loopback listener the metadata document cannot list", () =>
    withServer({ cimd: true }, (fake) =>
      Effect.gen(function* () {
        yield* prepare(fake, "http://127.0.0.1:4300/oauth/callback", "https://gateway.example")
        expect(fake.registrations.length).toBe(1)
      })
    ).pipe(Effect.provide(services))
  )
})
