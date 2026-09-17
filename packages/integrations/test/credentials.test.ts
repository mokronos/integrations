import { describe, expect, it } from "@effect/vitest"
import { randomBytes } from "node:crypto"
import { Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  connectionCredentialKey,
  CredentialStore,
  oauthClientCredentialKey,
  readTokens,
  writeTokens
} from "../src/storage/credentials.ts"
import { createEncryption } from "../src/storage/encryption.ts"
import { temporarySqlLayer } from "../src/runtime.ts"

const sqlStore = CredentialStore.sqlLayer(createEncryption(randomBytes(32))).pipe(
  Layer.provideMerge(temporarySqlLayer)
)

const decodeSealed = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ key: Schema.String, sealed: Schema.String })))

describe("the sql store", () => {
  it.effect("writes nothing readable to the table", () =>
    Effect.gen(function*() {
      const store = yield* CredentialStore
      const sql = yield* SqlClient.SqlClient
      yield* store.set(connectionCredentialKey("org.notes.primary"), "s3cret")

      const rows = decodeSealed(yield* sql.unsafe("SELECT key, sealed FROM credential"))
      expect(rows.map((row) => row.key)).toEqual(["connection:org.notes.primary"])
      expect(rows[0]?.sealed).not.toContain("s3cret")
    }).pipe(Effect.provide(sqlStore)))

  it.effect("reads back what it wrote, and forgets what it removed", () =>
    Effect.gen(function*() {
      const store = yield* CredentialStore
      const key = connectionCredentialKey("org.notes.primary")
      yield* store.set(key, "first")
      const first = yield* store.get(key)
      yield* store.set(key, "second")
      const second = yield* store.get(key)
      yield* store.remove(key)
      const gone = yield* store.get(key)

      expect({
        first: Option.getOrNull(first),
        second: Option.getOrNull(second),
        gone: Option.isNone(gone)
      }).toEqual({ first: "first", second: "second", gone: true })
    }).pipe(Effect.provide(sqlStore)))

  it("separates a client's secret from a connection's tokens", () => {
    expect(String(connectionCredentialKey("tools.notes.org.primary")))
      .toBe("connection:tools.notes.org.primary")
    expect(String(oauthClientCredentialKey("org", "notes-client")))
      .toBe("oauth-client:org:notes-client")
  })
})

describe("stored tokens", () => {
  it.effect("replaces access token, refresh token and expiry together", () =>
    Effect.gen(function*() {
      const store = yield* CredentialStore
      const key = connectionCredentialKey("org.notes.primary")

      yield* writeTokens(store, key, {
        accessToken: "a1",
        refreshToken: "r1",
        expiresAt: 1000,
        scope: "read"
      })
      expect(Option.getOrNull(yield* readTokens(store, key))).toEqual({
        accessToken: "a1",
        refreshToken: "r1",
        expiresAt: 1000,
        scope: "read"
      })

      yield* writeTokens(store, key, { accessToken: "a2", refreshToken: "r2" })
      expect(Option.getOrNull(yield* readTokens(store, key)))
        .toEqual({ accessToken: "a2", refreshToken: "r2" })
    }).pipe(Effect.provide(CredentialStore.memoryLayer)))

  it.effect("reads a connection with no grant as having none", () =>
    Effect.gen(function*() {
      const store = yield* CredentialStore

      const held = yield* readTokens(store, connectionCredentialKey("org.notes.absent"))

      expect(Option.isNone(held)).toBe(true)
    }).pipe(Effect.provide(CredentialStore.memoryLayer)))
})
