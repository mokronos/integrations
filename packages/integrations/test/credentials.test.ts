import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Effect, Encoding, Option } from "effect"
import { utf8Bytes } from "@integrations/contracts"
import {
  connectionCredentialKey,
  CredentialStore,
  oauthClientCredentialKey,
  openValue,
  readTokens,
  sealValue,
  writeTokens
} from "../src/storage/credentials.ts"
import { temporaryDirectory, testServices } from "./fixtures.ts"

describe("sealing", () => {
  it("round-trips a value under its own key", () => {
    const key = randomBytes(32)
    const sealed = sealValue(key, "s3cret")
    expect(sealed).toMatch(/^v1\./)
    expect(sealed).not.toContain("s3cret")
    expect(openValue(key, sealed)).toBe("s3cret")
  })

  it("refuses a value sealed under a different key", () => {
    const sealed = sealValue(randomBytes(32), "s3cret")
    expect(() => openValue(randomBytes(32), sealed)).toThrow()
  })

  it("refuses a tampered envelope", () => {
    const key = randomBytes(32)
    const [version, vector, tag, ciphertext] = sealValue(key, "s3cret").split(".")
    const swapped = [version, vector, tag, Encoding.encodeBase64Url(utf8Bytes("other"))].join(".")
    expect(() => openValue(key, swapped)).toThrow()
    expect(() => openValue(key, `v2.${vector}.${tag}.${ciphertext}`)).toThrow()
  })

  it("produces a different envelope each time for the same value", () => {
    const key = randomBytes(32)
    expect(sealValue(key, "same")).not.toBe(sealValue(key, "same"))
  })
})

describe("the file store", () => {
  it.effect("writes nothing readable to disk", () =>
    Effect.gen(function*() {
      const directory = yield* temporaryDirectory("credentials-")

      yield* Effect.gen(function*() {
        const store = yield* CredentialStore
        yield* store.set(connectionCredentialKey("org.notes.primary"), "s3cret")
      }).pipe(Effect.provide(CredentialStore.fileLayer(directory)))

      const onDisk = readFileSync(path.join(directory, "credentials.json"), "utf8")
      expect(onDisk).not.toContain("s3cret")
      expect(onDisk).toContain("connection:org.notes.primary")
    }).pipe(Effect.provide(testServices)))

  it.effect("reads back what it wrote, and forgets what it removed", () =>
    Effect.gen(function*() {
      const directory = yield* temporaryDirectory("credentials-")

      const outcome = yield* Effect.gen(function*() {
        const store = yield* CredentialStore
        const key = connectionCredentialKey("org.notes.primary")
        yield* store.set(key, "first")
        const first = yield* store.get(key)
        yield* store.set(key, "second")
        const second = yield* store.get(key)
        yield* store.remove(key)
        const gone = yield* store.get(key)
        return {
          first: Option.getOrNull(first),
          second: Option.getOrNull(second),
          gone: Option.isNone(gone)
        }
      }).pipe(Effect.provide(CredentialStore.fileLayer(directory)))

      expect(outcome).toEqual({ first: "first", second: "second", gone: true })
    }).pipe(Effect.provide(testServices)))

  it.effect("keeps concurrent writes from dropping each other", () =>
    Effect.gen(function*() {
      const directory = yield* temporaryDirectory("credentials-")

      const held = yield* Effect.gen(function*() {
        const store = yield* CredentialStore
        const keys = Array.from(
          { length: 12 },
          (_unused, index) => connectionCredentialKey(`org.notes.c${index}`)
        )
        yield* Effect.forEach(keys, (key) => store.set(key, `value-${key}`), {
          concurrency: "unbounded",
          discard: true
        })
        const values = yield* Effect.forEach(keys, (key) => store.get(key))
        return values.filter(Option.isSome).length
      }).pipe(Effect.provide(CredentialStore.fileLayer(directory)))

      expect(held).toBe(12)
    }).pipe(Effect.provide(testServices)))

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
