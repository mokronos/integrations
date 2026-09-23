import { createHash } from "node:crypto"
import { expect } from "@effect/vitest"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Test from "alchemy/Test/Vitest"
import { Effect, Schema } from "effect"
import { blobHandleKey } from "@integragents/contracts"
import Stack from "../alchemy.run.ts"

// Local development never calls Cloudflare, but Alchemy still resolves an account before planning.
process.env["CLOUDFLARE_ACCOUNT_ID"] ??= "0".repeat(32)
process.env["CLOUDFLARE_API_TOKEN"] ??= "local"

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  sidecar: false
})

const stack = beforeAll(deploy(Stack), { timeout: 180_000 }).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ url: Schema.String })))
)
afterAll(destroy(Stack), { timeout: 60_000 })

const Signup = Schema.Struct({ tenant: Schema.Struct({ id: Schema.String }) })
const Created = Schema.Struct({ id: Schema.String })
const Key = Schema.Struct({ secret: Schema.String })
const StoredBlob = Schema.Struct({ [blobHandleKey]: Schema.String, bytes: Schema.Number, sha256: Schema.String })
const Metadata = Schema.Struct({ token_endpoint: Schema.String })

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, response: Response) =>
  Effect.promise(() => response.json()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

test(
  "an operator signs up, provisions a client, and its key moves a blob larger than one upload part",
  Effect.gen(function*() {
    const { url } = yield* stack
    const call = (path: string, init?: RequestInit) => Effect.promise(() => fetch(`${url}${path}`, init))

    const signup = yield* call("/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${crypto.randomUUID()}@example.com`, password: "correct-horse-battery" })
    })
    expect(signup.status).toBe(201)
    yield* decode(Signup, signup)
    const session = { cookie: signup.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; "), origin: url }

    const client = yield* decode(Created, yield* call("/v1/clients", {
      method: "POST",
      headers: { ...session, "content-type": "application/json" },
      body: JSON.stringify({ name: "worker-test" })
    }))
    const key = yield* decode(Key, yield* call(`/v1/clients/${client.id}/keys`, { method: "POST", headers: session }))
    const bearer = { authorization: `Bearer ${key.secret}` }

    const body = new Uint8Array(9 * 1024 * 1024).map((_, index) => index % 251)
    const uploaded = yield* call("/v1/blobs", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/octet-stream" },
      body
    })
    expect(uploaded.status).toBe(200)
    const blob = yield* decode(StoredBlob, uploaded)
    expect(blob.bytes).toBe(body.length)
    expect(blob.sha256).toBe(sha256(body))

    const downloaded = yield* call(`/v1/blobs/${blob[blobHandleKey]}`, { headers: bearer })
    const bytes = new Uint8Array(yield* Effect.promise(() => downloaded.arrayBuffer()))
    expect(sha256(bytes)).toBe(blob.sha256)
  }),
  { timeout: 60_000 }
)

test(
  "MCP clients discover the authorization server while dashboard routes stay with the dashboard",
  Effect.gen(function*() {
    const { url } = yield* stack
    const metadata = yield* Effect.promise(() => fetch(`${url}/.well-known/oauth-authorization-server`))
    expect((yield* decode(Metadata, metadata)).token_endpoint).toBe(`${url}/oauth/token`)

    const consent = yield* Effect.promise(() =>
      fetch(`${url}/oauth/consent?request=x`, { headers: { accept: "text/html", "sec-fetch-mode": "navigate" } })
    )
    expect(yield* Effect.promise(() => consent.text())).toContain("<div id=\"root\">")
  }),
  { timeout: 30_000 }
)
