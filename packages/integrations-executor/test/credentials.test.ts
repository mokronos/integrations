import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Effect, Option } from "effect"
import {
  connectionCredentialKey,
  CredentialStore,
  oauthClientCredentialKey,
  openValue,
  readTokens,
  sealValue,
  writeTokens
} from "../src/credentials.ts"

const withDirectory = async <A>(use: (directory: string) => Promise<A>): Promise<A> => {
  const directory = mkdtempSync(path.join(tmpdir(), "integrations-credentials-"))
  try {
    return await use(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("sealing", () => {
  it("round-trips a value under its own key", () => {
    const key = randomBytes(32)
    const sealed = sealValue(key, "s3cret")
    expect(sealed.startsWith("v1.")).toBe(true)
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
    // Authentication covers the ciphertext, so a flipped payload is detected
    // rather than decrypted into rubbish.
    const swapped = [version, vector, tag, Buffer.from("other").toString("base64url")].join(".")
    expect(() => openValue(key, swapped)).toThrow()
    expect(() => openValue(key, `v2.${vector}.${tag}.${ciphertext}`)).toThrow()
  })

  it("produces a different envelope each time for the same value", () => {
    const key = randomBytes(32)
    expect(sealValue(key, "same")).not.toBe(sealValue(key, "same"))
  })
})

describe("the file store", () => {
  it("writes nothing readable to disk", async () => {
    await withDirectory(async (directory) => {
      await Effect.runPromise(Effect.gen(function* () {
        const store = yield* CredentialStore
        yield* store.set(connectionCredentialKey("org.notes.primary"), "s3cret")
      }).pipe(Effect.provide(CredentialStore.fileLayer(directory))))

      const onDisk = readFileSync(path.join(directory, "credentials.json"), "utf8")
      expect(onDisk).not.toContain("s3cret")
      expect(onDisk).toContain("connection:org.notes.primary")
    })
  })

  it("reads back what it wrote, and forgets what it removed", async () => {
    const outcome = await withDirectory((directory) =>
      Effect.runPromise(Effect.gen(function* () {
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
      }).pipe(Effect.provide(CredentialStore.fileLayer(directory))))
    )
    expect(outcome).toEqual({ first: "first", second: "second", gone: true })
  })

  it("keeps concurrent writes from dropping each other", async () => {
    // Every mutation is a read-modify-write of the whole file, so without a
    // permit the last writer would win and the others would vanish.
    const held = await withDirectory((directory) =>
      Effect.runPromise(Effect.gen(function* () {
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
      }).pipe(Effect.provide(CredentialStore.fileLayer(directory))))
    )
    expect(held).toBe(12)
  })

  it("separates a client's secret from a connection's tokens", () => {
    expect(String(connectionCredentialKey("tools.notes.org.primary")))
      .toBe("connection:tools.notes.org.primary")
    expect(String(oauthClientCredentialKey("org", "notes-client")))
      .toBe("oauth-client:org:notes-client")
  })
})

describe("stored tokens", () => {
  it("replaces access token, refresh token and expiry together", async () => {
    const outcome = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* CredentialStore
      const key = connectionCredentialKey("org.notes.primary")
      yield* writeTokens(store, key, {
        accessToken: "a1",
        refreshToken: "r1",
        expiresAt: 1000,
        scope: "read"
      })
      const first = yield* readTokens(store, key)
      yield* writeTokens(store, key, { accessToken: "a2", refreshToken: "r2" })
      const second = yield* readTokens(store, key)
      return { first: Option.getOrNull(first), second: Option.getOrNull(second) }
    }).pipe(Effect.provide(CredentialStore.memoryLayer)))

    expect(outcome.first).toEqual({
      accessToken: "a1",
      refreshToken: "r1",
      expiresAt: 1000,
      scope: "read"
    })
    // A refresh rewrites the whole grant, so no stale expiry survives it.
    expect(outcome.second).toEqual({ accessToken: "a2", refreshToken: "r2" })
  })

  it("reads a connection with no grant as having none", async () => {
    const held = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* CredentialStore
      return yield* readTokens(store, connectionCredentialKey("org.notes.absent"))
    }).pipe(Effect.provide(CredentialStore.memoryLayer)))
    expect(Option.isNone(held)).toBe(true)
  })
})
