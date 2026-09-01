import { run, runAll } from "./effect.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { createClient as openRawDatabase } from "@libsql/client"
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
import type { Encryption, GatewayStore } from "../src/index.ts"
import { canonicalArguments } from "../src/domain.ts"

const directories: Array<string> = []
const stores: Array<GatewayStore> = []

afterEach(async () => {
  await runAll(stores.splice(0).map((store) => store.close()))
  await run(Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  ))
})

const tempDir = async (): Promise<string> => {
  const directory = await run(mkdtemp(path.join(tmpdir(), "wf-gateway-crypto-")))
  directories.push(directory)
  return directory
}

const secretText = '{"to":["customer@example.com"],"subject":"Private"}'

describe("payload sealing", () => {
  const encryption = createEncryption(randomBytes(32))

  test("round-trips a sealed value", () => {
    const sealed = encryption.seal(secretText)
    expect(sealed.startsWith("enc.v1$")).toBe(true)
    expect(encryption.open(sealed)).toBe(secretText)
  })

  test("never produces equal ciphertexts for equal inputs", () => {
    expect(encryption.seal(secretText)).not.toBe(encryption.seal(secretText))
  })

  test("passes unsealed values through untouched", () => {
    // Rows written before a key existed stay readable without migration.
    expect(encryption.open(secretText)).toBe(secretText)
  })

  test("refuses a sealed value whose ciphertext was altered", () => {
    const parts = encryption.seal(secretText).split("$")
    const ivText = parts[1]
    const tagText = parts[2]
    const data = parts[3]
    if (parts[0] !== "enc.v1" || ivText === undefined || tagText === undefined || data === undefined) {
      throw new Error("test produced a malformed envelope")
    }
    const bytes = Buffer.from(data, "base64")
    const lastIndex = bytes.length - 1
    bytes[lastIndex] = (bytes[lastIndex] ?? 0) ^ 0xff
    const tampered = `enc.v1$${ivText}$${tagText}$${bytes.toString("base64")}`
    expect(() => encryption.open(tampered)).toThrow()
  })

  test("refuses a truncated envelope", () => {
    expect(() => encryption.open("enc.v1$only-one-field")).toThrow()
  })

  test("answers equality lookups without exposing the answer", () => {
    const digest = encryption.lookup(secretText)
    expect(digest).toBe(encryption.lookup(secretText))
    expect(digest).not.toBe(encryption.lookup(`${secretText} `))
    expect(digest).not.toContain("customer@example.com")
  })
})

describe("master key resolution", () => {
  test("is absent when nothing is configured", async () => {
    expect(await run(resolveEncryption({}))).toBeUndefined()
  })

  test("uses an environment key of exactly 32 bytes", async () => {
    const key = randomBytes(32).toString("base64url")
    const encryption = await run(resolveEncryption({ envValue: key }))
    if (encryption === undefined) throw new Error("expected an encryption instance")
    expect(encryption.open(encryption.seal("round trip"))).toBe("round trip")
  })

  test("rejects an environment key of the wrong length", async () => {
    expect(resolveEncryption({ envValue: "tooshort" })).rejects.toThrow("32 bytes")
  })

  test("mints a private keyfile when only a path is given", async () => {
    const directory = await run(tempDir())
    const keyFile = path.join(directory, "nested", "gateway.key")
    const encryption = await run(resolveEncryption({ keyFile }))
    expect(encryption).toBeDefined()
    const info = statSync(keyFile)
    expect(info.mode & 0o777).toBe(0o600)
    expect(info.size).toBe(32)
  })

  test("reuses an existing keyfile across starts", async () => {
    const directory = await run(tempDir())
    const keyFile = path.join(directory, "gateway.key")
    const first = await run(resolveEncryption({ keyFile }))
    const second = await run(resolveEncryption({ keyFile }))
    if (first === undefined || second === undefined) {
      throw new Error("expected both resolutions to produce instances")
    }
    // A value sealed under one start opens under the next.
    expect(second.open(first.seal("persist"))).toBe("persist")
  })

  test("the environment wins over an existing keyfile", async () => {
    const directory = await run(tempDir())
    const keyFile = path.join(directory, "gateway.key")
    await run(resolveEncryption({ keyFile }))
    const environmentKey = randomBytes(32).toString("base64url")

    const encryption = await run(resolveEncryption({ envValue: environmentKey, keyFile }))
    if (encryption === undefined) throw new Error("expected an encryption instance")
    const sealed = encryption.seal("decides")

    // Opens under the environment key...
    expect(createEncryption(Buffer.from(environmentKey, "base64url")).open(sealed)).toBe("decides")
    // ...and not under the file key it superseded.
    const fileKey = createEncryption((await run(import("node:fs"))).readFileSync(keyFile))
    expect(() => fileKey.open(sealed)).toThrow()
  })
})

describe("the encrypted store", () => {
  const connection = {
    owner: "org" as const,
    integration: IntegrationSlug.make("gmail"),
    name: ConnectionName.make("work")
  }

  const makeEncryptedStore = async (): Promise<{
    store: GatewayStore
    raw: ReturnType<typeof openRawDatabase>
    databasePath: string
    encryption: Encryption
  }> => {
    const directory = await run(tempDir())
    const databasePath = path.join(directory, "gateway.sqlite")
    const encryption = createEncryption(randomBytes(32))
    const store = await run(createGatewayStore(databasePath, encryption))
    stores.push(store)
    const raw = openRawDatabase({ url: `file:${databasePath}` })
    return { store, raw, databasePath, encryption }
  }

  const seedClient = async (store: GatewayStore) => {
    const accessProfile = await run(store.createAccessProfile({
      id: newAccessProfileId(), tenantId: defaultTenantId, name: `profile-${crypto.randomUUID()}`
    }))
    await run(store.replaceAccessProfileTools(accessProfile.id, [{ connection, tool: ToolName.make("sendEmail") }]))
    const approvalPolicy = await run(store.createApprovalPolicy({
      id: newApprovalPolicyId(), tenantId: defaultTenantId, name: `policy-${crypto.randomUUID()}`
    }))
    await run(store.replaceApprovalPolicyTools(approvalPolicy.id, [{
      connection, tool: ToolName.make("sendEmail"), decision: "require_approval"
    }]))
    const client = await run(store.createClient({
      id: newClientId(),
      tenantId: defaultTenantId,
      accessProfileId: accessProfile.id,
      approvalPolicyId: approvalPolicy.id,
      name: "agent",
      capabilities: ["provision_connections"]
    }))
    return { client, accessProfile, approvalPolicy }
  }

  test("stores frozen-call arguments sealed, yet retries still meet them", async () => {
    const { store, raw } = await run(makeEncryptedStore())
    const { client, accessProfile, approvalPolicy } = await run(seedClient(store))
    const argumentsValue = { to: "customer@example.com", subject: "Private" }

    const approval = await run(store.createApproval({
      id: newApprovalId(),
      tenantId: defaultTenantId,
      clientId: client.id,
      approvalPolicyId: approvalPolicy.id,
      accessProfileId: accessProfile.id,
      alias: Alias.make("gmail-work"),
      tool: ToolName.make("sendEmail"),
      arguments: argumentsValue,
      expiresAt: new Date(Date.now() + 60_000)
    }))

    const storedArguments = String(
      (await run(raw.execute(
        "SELECT arguments FROM gateway_pending_approval WHERE id = ?",
        [approval.id]
      ))).rows[0]?.["arguments"]
    )
    // Nothing readable where the PII lives...
    expect(storedArguments).toContain("enc.v1$")
    expect(storedArguments).not.toContain("customer@example.com")

    // ...and the retry still finds its frozen call.
    const metAgain = await run(store.findUncollectedApproval(approvalPolicy.id, accessProfile.id, ToolName.make("sendEmail"), argumentsValue))
    expect(metAgain === undefined ? "" : metAgain.id).toBe(approval.id)
    expect(metAgain?.arguments).toEqual(argumentsValue)
  })

  test("seals a settled result while reading it back intact", async () => {
    const { store, raw } = await run(makeEncryptedStore())
    const { client, accessProfile, approvalPolicy } = await run(seedClient(store))
    const id = newApprovalId()
    await run(store.createApproval({
      id,
      tenantId: defaultTenantId,
      clientId: client.id,
      approvalPolicyId: approvalPolicy.id,
      accessProfileId: accessProfile.id,
      alias: Alias.make("gmail-work"),
      tool: ToolName.make("sendEmail"),
      arguments: {},
      expiresAt: new Date(Date.now() + 60_000)
    }))
    await run(store.settleApproval({
      tenantId: defaultTenantId,
      id,
      status: "approved",
      decidedBy: "sebastian",
      result: { messageId: "secret-message-id" },
      error: null
    }))

    const storedResult = String(
      (await run(raw.execute(
        "SELECT result FROM gateway_pending_approval WHERE id = ?",
        [id]
      ))).rows[0]?.["result"]
    )
    expect(storedResult).toContain("enc.v1$")
    expect(storedResult).not.toContain("secret-message-id")

    const settled = await run(store.getApproval(defaultTenantId, id))
    expect(settled?.result).toEqual({ messageId: "secret-message-id" })
  })

  test("seals audit arguments at rest", async () => {
    const { store, raw } = await run(makeEncryptedStore())
    const id = newAuditId()
    await run(store.recordAudit({
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
    }))

    const stored = String(
      (await run(raw.execute(
        "SELECT arguments FROM gateway_audit_arguments WHERE audit_id = ?",
        [id]
      ))).rows[0]?.["arguments"]
    )
    expect(stored).toContain("enc.v1$")
    expect(stored).not.toContain("personal data")
  })

  test("still matches pre-encryption rows written in plaintext", async () => {
    const { store, raw } = await run(makeEncryptedStore())
    const { client, accessProfile, approvalPolicy } = await run(seedClient(store))

    // A frozen call from before the master key existed: canonical JSON in the
    // clear, no lookup digest.
    const canonical = canonicalArguments({ to: "old@example.com" })
    await run(raw.execute(
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
        canonical,
        Date.now() + 60_000
      ]
    ))

    const metAgain = await run(store.findUncollectedApproval(approvalPolicy.id, accessProfile.id, ToolName.make("sendEmail"), { to: "old@example.com" }))
    expect(metAgain === undefined ? "" : metAgain.id).toBe("legacy-approval")
    expect(metAgain?.arguments).toEqual({ to: "old@example.com" })
  })

  test("a store without a key keeps storing plaintext", async () => {
    const directory = await run(tempDir())
    const databasePath = path.join(directory, "gateway.sqlite")
    const store = await run(createGatewayStore(databasePath))
    stores.push(store)
    const accessProfile = await run(store.createAccessProfile({
      id: newAccessProfileId(), tenantId: defaultTenantId, name: "plaintext profile"
    }))
    const approvalPolicy = await run(store.createApprovalPolicy({
      id: newApprovalPolicyId(), tenantId: defaultTenantId, name: "plaintext policy"
    }))
    const client = await run(store.createClient({
      id: newClientId(),
      tenantId: defaultTenantId,
      accessProfileId: accessProfile.id,
      approvalPolicyId: approvalPolicy.id,
      name: "agent",
      capabilities: ["provision_connections"]
    }))
    const approval = await run(store.createApproval({
      id: newApprovalId(),
      tenantId: defaultTenantId,
      clientId: client.id,
      approvalPolicyId: approvalPolicy.id,
      accessProfileId: accessProfile.id,
      alias: Alias.make("gmail-work"),
      tool: ToolName.make("sendEmail"),
      arguments: { visible: true },
      expiresAt: new Date(Date.now() + 60_000)
    }))

    const raw = openRawDatabase({ url: `file:${databasePath}` })
    const storedArguments = String(
      (await run(raw.execute(
        "SELECT arguments FROM gateway_pending_approval WHERE id = ?",
        [approval.id]
      ))).rows[0]?.["arguments"]
    )
    expect(storedArguments).toBe('{"visible":true}')
    raw.close()
  })
})
