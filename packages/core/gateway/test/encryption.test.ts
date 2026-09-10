import { describe, expect, it } from "@effect/vitest"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { createClient as openRawDatabase } from "@libsql/client"
import { Effect, Encoding, Schema } from "effect"
import { decodeBase64Field, decodeBase64UrlField } from "@integrations/contracts"
import {
  Alias,
  ConnectionName,
  createEncryption,
  createGatewayStore,
  defaultTenantId,
  IntegrationSlug,
  newApprovalId,
  newAuditId,
  newClientId,
  newAccessProfileId,
  newApprovalPolicyId,
  resolveEncryption,
  ToolName
} from "../src/index.ts"
import type { GatewayStore } from "../src/index.ts"
import { canonicalArguments } from "../src/domain.ts"
import { temporaryDirectory, testServices } from "./fixtures.ts"

class KeyRefused extends Schema.TaggedError<KeyRefused>()("KeyRefused", {
  message: Schema.String
}) {}

/** `resolveEncryption` reads and mints keyfiles as a plain promise. */
const resolve = (source: Parameters<typeof resolveEncryption>[0]) =>
  Effect.tryPromise({
    try: () => resolveEncryption(source),
    catch: (cause) => new KeyRefused({ message: String(cause) })
  })

const secretText = '{"to":["customer@example.com"],"subject":"Private"}'

describe("payload sealing", () => {
  const encryption = createEncryption(randomBytes(32))

  it("round-trips a sealed value", () => {
    const sealed = encryption.seal(secretText)
    expect(sealed).toMatch(/^enc\.v1\$/)
    expect(encryption.open(sealed)).toBe(secretText)
  })

  it("never produces equal ciphertexts for equal inputs", () => {
    expect(encryption.seal(secretText)).not.toBe(encryption.seal(secretText))
  })

  it("passes unsealed values through untouched", () => {
    expect(encryption.open(secretText)).toBe(secretText)
  })

  it("refuses a sealed value whose ciphertext was altered", () => {
    const [version, ivText, tagText, data] = encryption.seal(secretText).split("$")
    if (
      version !== "enc.v1" || ivText === undefined || tagText === undefined || data === undefined
    ) {
      throw new Error("test produced a malformed envelope")
    }
    const bytes = decodeBase64Field("ciphertext", data)
    const lastIndex = bytes.length - 1
    bytes[lastIndex] = (bytes[lastIndex] ?? 0) ^ 0xff
    const tampered = `enc.v1$${ivText}$${tagText}$${Encoding.encodeBase64(bytes)}`

    expect(() => encryption.open(tampered)).toThrow()
  })

  it("refuses a truncated envelope", () => {
    expect(() => encryption.open("enc.v1$only-one-field")).toThrow()
  })

  it("answers equality lookups without exposing the answer", () => {
    const digest = encryption.lookup(secretText)
    expect(digest).toBe(encryption.lookup(secretText))
    expect(digest).not.toBe(encryption.lookup(`${secretText} `))
    expect(digest).not.toContain("customer@example.com")
  })
})

describe("master key resolution", () => {
  it.effect("is absent when nothing is configured", () =>
    Effect.gen(function*() {
      expect(yield* resolve({})).toBeUndefined()
    }))

  it.effect("uses an environment key of exactly 32 bytes", () =>
    Effect.gen(function*() {
      const key = Encoding.encodeBase64Url(randomBytes(32))
      const encryption = yield* resolve({ envValue: key })
      if (encryption === undefined) throw new Error("expected an encryption instance")
      expect(encryption.open(encryption.seal("round trip"))).toBe("round trip")
    }))

  it.effect("rejects an environment key of the wrong length", () =>
    Effect.gen(function*() {
      const outcome = yield* Effect.result(resolve({ envValue: "tooshort" }))
      expect(outcome._tag).toBe("Failure")
      expect(outcome._tag === "Failure" ? outcome.failure.message : "").toContain("32 bytes")
    }))

  it.effect("mints a private keyfile when only a path is given", () =>
    Effect.gen(function*() {
      const directory = yield* temporaryDirectory("gateway-crypto-")
      const keyFile = path.join(directory, "nested", "gateway.key")

      expect(yield* resolve({ keyFile })).toBeDefined()

      const info = statSync(keyFile)
      expect(info.mode & 0o777).toBe(0o600)
      expect(info.size).toBe(32)
    }).pipe(Effect.provide(testServices)))

  it.effect("reuses an existing keyfile across starts", () =>
    Effect.gen(function*() {
      const directory = yield* temporaryDirectory("gateway-crypto-")
      const keyFile = path.join(directory, "gateway.key")

      const first = yield* resolve({ keyFile })
      const second = yield* resolve({ keyFile })

      if (first === undefined || second === undefined) {
        throw new Error("expected both resolutions to produce instances")
      }
      expect(second.open(first.seal("persist"))).toBe("persist")
    }).pipe(Effect.provide(testServices)))

  it.effect("the environment wins over an existing keyfile", () =>
    Effect.gen(function*() {
      const directory = yield* temporaryDirectory("gateway-crypto-")
      const keyFile = path.join(directory, "gateway.key")
      yield* resolve({ keyFile })
      const environmentKey = Encoding.encodeBase64Url(randomBytes(32))

      const encryption = yield* resolve({ envValue: environmentKey, keyFile })
      if (encryption === undefined) throw new Error("expected an encryption instance")
      const sealed = encryption.seal("decides")

      expect(createEncryption(decodeBase64UrlField("key", environmentKey)).open(sealed))
        .toBe("decides")
      const fromFile = createEncryption(readFileSync(keyFile))
      expect(() => fromFile.open(sealed)).toThrow()
    }).pipe(Effect.provide(testServices)))
})

/**
 * Approvals carry an expiry the store compares against the system clock, which
 * it reads directly, so these run live and date their fixtures the same way.
 */
describe("the encrypted store", () => {
  const connection = {
    owner: "org" as const,
    integration: IntegrationSlug.make("gmail"),
    name: ConnectionName.make("work")
  }

  /** A store whose rows can also be read raw, to see what actually landed. */
  const encryptedStore = Effect.fnUntraced(function*(options: { readonly sealed: boolean } = {
    sealed: true
  }) {
    const directory = yield* temporaryDirectory("gateway-crypto-")
    const databasePath = path.join(directory, "gateway.sqlite")
    const store = yield* Effect.acquireRelease(
      options.sealed
        ? createGatewayStore(databasePath, createEncryption(randomBytes(32)))
        : createGatewayStore(databasePath),
      (store) => Effect.orDie(store.close())
    )
    const raw = yield* Effect.acquireRelease(
      Effect.sync(() => openRawDatabase({ url: `file:${databasePath}` })),
      (raw) => Effect.sync(() => raw.close())
    )
    const column = (table: string, name: string, key: string, id: string) =>
      Effect.map(
        Effect.promise(() => raw.execute(`SELECT ${name} FROM ${table} WHERE ${key} = ?`, [id])),
        (result) => String(result.rows[0]?.[name])
      )
    return { store, raw, column }
  })

  const seedClient = Effect.fnUntraced(function*(store: GatewayStore) {
    const accessProfile = yield* store.createAccessProfile({
      id: yield* newAccessProfileId,
      tenantId: defaultTenantId,
      name: `profile-${crypto.randomUUID()}`
    })
    yield* store.replaceAccessProfileTools(accessProfile.id, [
      { connection, tool: ToolName.make("sendEmail") }
    ])
    const approvalPolicy = yield* store.createApprovalPolicy({
      id: yield* newApprovalPolicyId,
      tenantId: defaultTenantId,
      name: `policy-${crypto.randomUUID()}`
    })
    yield* store.replaceApprovalPolicyTools(approvalPolicy.id, [{
      connection, tool: ToolName.make("sendEmail"), decision: "require_approval"
    }])
    const client = yield* store.createClient({
      id: yield* newClientId,
      tenantId: defaultTenantId,
      accessProfileId: accessProfile.id,
      approvalPolicyId: approvalPolicy.id,
      name: "agent",
      capabilities: ["provision_connections"]
    })
    return { client, accessProfile, approvalPolicy }
  })

  it.live("stores frozen-call arguments sealed, yet retries still meet them", () =>
    Effect.gen(function*() {
      const { column, store } = yield* encryptedStore()
      const { accessProfile, approvalPolicy, client } = yield* seedClient(store)
      const argumentsValue = { to: "customer@example.com", subject: "Private" }

      const approval = yield* store.createApproval({
        id: yield* newApprovalId,
        tenantId: defaultTenantId,
        clientId: client.id,
        approvalPolicyId: approvalPolicy.id,
        accessProfileId: accessProfile.id,
        alias: Alias.make("gmail-work"),
        tool: ToolName.make("sendEmail"),
        arguments: argumentsValue,
        expiresAt: new Date(Date.now() + 60_000)
      })

      const stored = yield* column("gateway_pending_approval", "arguments", "id", approval.id)
      expect(stored).toContain("enc.v1$")
      expect(stored).not.toContain("customer@example.com")

      const metAgain = yield* store.findUncollectedApproval({
        tenantId: defaultTenantId,
        clientId: client.id,
        alias: Alias.make("gmail-work"),
        approvalPolicyId: approvalPolicy.id,
        accessProfileId: accessProfile.id,
        tool: ToolName.make("sendEmail"),
        arguments: argumentsValue
      })
      expect(metAgain?.id).toBe(approval.id)
      expect(metAgain?.arguments).toEqual(argumentsValue)
    }).pipe(Effect.provide(testServices)))

  it.live("seals a settled result while reading it back intact", () =>
    Effect.gen(function*() {
      const { column, store } = yield* encryptedStore()
      const { accessProfile, approvalPolicy, client } = yield* seedClient(store)
      const id = yield* newApprovalId
      yield* store.createApproval({
        id,
        tenantId: defaultTenantId,
        clientId: client.id,
        approvalPolicyId: approvalPolicy.id,
        accessProfileId: accessProfile.id,
        alias: Alias.make("gmail-work"),
        tool: ToolName.make("sendEmail"),
        arguments: {},
        expiresAt: new Date(Date.now() + 60_000)
      })
      yield* store.claimApproval({ tenantId: defaultTenantId, id, decidedBy: "sebastian" })
      yield* store.settleApproval({
        tenantId: defaultTenantId,
        id,
        status: "approved",
        decidedBy: "sebastian",
        result: { messageId: "secret-message-id" },
        error: null
      })

      const stored = yield* column("gateway_pending_approval", "result", "id", id)
      expect(stored).toContain("enc.v1$")
      expect(stored).not.toContain("secret-message-id")

      expect((yield* store.getApproval(defaultTenantId, id))?.result)
        .toEqual({ messageId: "secret-message-id" })
    }).pipe(Effect.provide(testServices)))

  it.live("seals audit arguments at rest", () =>
    Effect.gen(function*() {
      const { column, store } = yield* encryptedStore()
      const id = yield* newAuditId
      yield* store.recordAudit({
        tenantId: defaultTenantId,
        id,
        clientId: null,
        alias: null,
        tool: null,
        connection: null,
        decision: null,
        outcome: "succeeded",
        message: null,
        arguments: {
          value: { body: "personal data ages out" },
          expiresAt: new Date(Date.now() - 1_000)
        }
      })

      const stored = yield* column("gateway_audit_arguments", "arguments", "audit_id", id)
      expect(stored).toContain("enc.v1$")
      expect(stored).not.toContain("personal data")
    }).pipe(Effect.provide(testServices)))

  it.live("still matches pre-encryption rows written in plaintext", () =>
    Effect.gen(function*() {
      const { raw, store } = yield* encryptedStore()
      const { accessProfile, approvalPolicy, client } = yield* seedClient(store)

      yield* Effect.promise(() =>
        raw.execute(
          `INSERT INTO gateway_pending_approval
             (id, tenant_id, client_id, approval_policy_id, access_profile_id, alias, tool, arguments, status, created_at, expires_at, collected_at)
           VALUES ('legacy-approval', ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL)`,
          [
            defaultTenantId,
            client.id,
            approvalPolicy.id,
            accessProfile.id,
            Alias.make("gmail-work"),
            ToolName.make("sendEmail"),
            canonicalArguments({ to: "old@example.com" }),
            Date.now() + 60_000
          ]
        )
      )

      const metAgain = yield* store.findUncollectedApproval({
        tenantId: defaultTenantId,
        clientId: client.id,
        alias: Alias.make("gmail-work"),
        approvalPolicyId: approvalPolicy.id,
        accessProfileId: accessProfile.id,
        tool: ToolName.make("sendEmail"),
        arguments: { to: "old@example.com" }
      })
      expect(metAgain?.id).toBe("legacy-approval")
      expect(metAgain?.arguments).toEqual({ to: "old@example.com" })
    }).pipe(Effect.provide(testServices)))

  it.live("a store without a key keeps storing plaintext", () =>
    Effect.gen(function*() {
      const { column, store } = yield* encryptedStore({ sealed: false })
      const { accessProfile, approvalPolicy, client } = yield* seedClient(store)

      const approval = yield* store.createApproval({
        id: yield* newApprovalId,
        tenantId: defaultTenantId,
        clientId: client.id,
        approvalPolicyId: approvalPolicy.id,
        accessProfileId: accessProfile.id,
        alias: Alias.make("gmail-work"),
        tool: ToolName.make("sendEmail"),
        arguments: { visible: true },
        expiresAt: new Date(Date.now() + 60_000)
      })

      expect(yield* column("gateway_pending_approval", "arguments", "id", approval.id))
        .toBe('{"visible":true}')
    }).pipe(Effect.provide(testServices)))
})
