import { run, runAll } from "./effect.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  Alias,
  authorizeClientCapability,
  authorizeInvocation,
  ConnectionName,
  createGatewayStore,
  defaultTenantId,
  generateApiKey,
  IntegrationSlug,
  newClientId,
  newClientToolBindingId,
  newPolicyId,
  SubjectId,
  ToolName
} from "../src/index.ts"
import type { ConnectionRef, GatewayStore } from "../src/index.ts"

const directories: Array<string> = []
const stores: Array<GatewayStore> = []

afterEach(async () => {
  await runAll(stores.splice(0).map((store) => store.close()))
  await run(Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  ))
})

const makeStore = async (): Promise<GatewayStore> => {
  const directory = await run(mkdtemp(path.join(tmpdir(), "wf-gateway-")))
  directories.push(directory)
  const store = await run(createGatewayStore(path.join(directory, "gateway.sqlite")))
  stores.push(store)
  return store
}

const orgConnection: ConnectionRef = {
  owner: "org",
  integration: IntegrationSlug.make("sharepoint"),
  name: ConnectionName.make("default")
}

const userConnection: ConnectionRef = {
  owner: "user",
  subject: SubjectId.make("sebastian"),
  integration: IntegrationSlug.make("gmail"),
  name: ConnectionName.make("work")
}

const seed = async (store: GatewayStore, options: {
  readonly capabilities?: ReadonlyArray<"provision_connections" | "administer_gateway">
  readonly connection?: ConnectionRef
  readonly decision?: "allow" | "require_approval"
} = {}) => {
  const policy = await run(store.createPolicy({
    id: newPolicyId(),
    tenantId: defaultTenantId,
    name: `policy-${crypto.randomUUID()}`
  }))
  const client = await run(store.createClient({
    id: newClientId(),
    tenantId: defaultTenantId,
    policyId: policy.id,
    name: "support-agent",
    capabilities: options.capabilities ?? ["provision_connections"]
  }))
  const key = generateApiKey()
  await run(store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash }))
  const policyConnection = options.connection ?? orgConnection
  await run(store.replacePolicyConfiguration(policy.id, {
    integrations: [policyConnection.integration],
    tools: [{
      connection: policyConnection,
      tool: ToolName.make("getDocument"),
      enabled: true,
      decision: options.decision ?? "allow"
    }]
  }))
  const binding = await run(store.createBinding({
    id: newClientToolBindingId(),
    tenantId: defaultTenantId,
    clientId: client.id,
    alias: Alias.make("sharepoint-app"),
    tool: ToolName.make("getDocument"),
    connection: options.connection ?? orgConnection,
  }))
  return { client, key, policy, binding }
}

const invoke = (store: GatewayStore, secret: string, alias = "sharepoint-app", tool = "getDocument") =>
  authorizeInvocation(store, {
    secret,
    alias: Alias.make(alias),
    tool: ToolName.make(tool)
  })

describe("gateway authorization", () => {
  test("authorizes an effective tool and names the connection it resolves to", async () => {
    const store = await run(makeStore())
    const { key, binding } = await run(seed(store))

    const result = await run(invoke(store, key.secret))

    expect(result.status).toBe("authorized")
    if (result.status !== "authorized") return
    expect(result.binding.id).toBe(binding.id)
    expect(result.connection).toEqual(orgConnection)
    // An org-tier connection belongs to the tenant, so no human is acted for.
    expect(result.subject).toBeNull()
  })

  test("derives the human acted for from the connection, not the key", async () => {
    const store = await run(makeStore())
    const { key } = await run(seed(store, { connection: userConnection }))

    const result = await run(invoke(store, key.secret))

    expect(result.status).toBe("authorized")
    if (result.status !== "authorized") return
    // The delegation lives in the binding. Nothing in the API key says Sebastian.
    expect(result.subject).toBe(SubjectId.make("sebastian"))
  })

  test("carries the policy's approval decision through", async () => {
    const store = await run(makeStore())
    const { key } = await run(seed(store, { decision: "require_approval" }))

    const result = await run(invoke(store, key.secret))

    expect(result.status).toBe("authorized")
    if (result.status !== "authorized") return
    expect(result.decision).toBe("require_approval")
  })

  test("rejects an unknown key", async () => {
    const store = await run(makeStore())
    await run(seed(store))

    expect((await run(invoke(store, "wfi_not-a-real-key"))).status).toBe("unknown-key")
  })

  test("denies a revoked key immediately", async () => {
    const store = await run(makeStore())
    const { key } = await run(seed(store))
    expect((await run(invoke(store, key.secret))).status).toBe("authorized")

    await run(store.revokeApiKey(key.id))

    expect((await run(invoke(store, key.secret))).status).toBe("key-revoked")
  })

  test("denies every key of a revoked client", async () => {
    const store = await run(makeStore())
    const { client, key } = await run(seed(store))
    const second = generateApiKey()
    await run(store.addApiKey({ id: second.id, clientId: client.id, hash: second.hash }))

    await run(store.revokeClient(defaultTenantId, client.id))

    expect((await run(invoke(store, key.secret))).status).toBe("client-revoked")
    expect((await run(invoke(store, second.secret))).status).toBe("client-revoked")
  })

  test("a second live key keeps working while the first is rotated out", async () => {
    const store = await run(makeStore())
    const { client, key } = await run(seed(store))
    const replacement = generateApiKey()
    await run(store.addApiKey({ id: replacement.id, clientId: client.id, hash: replacement.hash }))

    await run(store.revokeApiKey(key.id))

    // Rotation is overlap-then-retire: the client sends one key, the gateway
    // accepts both for a window.
    expect((await run(invoke(store, key.secret))).status).toBe("key-revoked")
    expect((await run(invoke(store, replacement.secret))).status).toBe("authorized")
  })

  test("denies a tool outside the policy and binding intersection", async () => {
    const store = await run(makeStore())
    const { key } = await run(seed(store))

    const result = await run(invoke(store, key.secret, "sharepoint-app", "deleteDocument"))

    expect(result.status).toBe("not-authorized")
  })

  test("does not distinguish an unknown alias from an unauthorized tool", async () => {
    const store = await run(makeStore())
    const { key } = await run(seed(store))

    const unknownAlias = await run(invoke(store, key.secret, "nothing-here", "getDocument"))
    const unauthorizedTool = await run(invoke(store, key.secret, "sharepoint-app", "deleteDocument"))

    // Telling these apart would let a caller enumerate what else is connected.
    expect(unknownAlias.status).toBe(unauthorizedTool.status)
  })

  test("denies a revoked binding while leaving the client usable", async () => {
    const store = await run(makeStore())
    const { client, key, binding } = await run(seed(store))
    await run(store.replacePolicyConfiguration(client.policyId, {
      integrations: [orgConnection.integration, userConnection.integration],
      tools: [
        { connection: orgConnection, tool: ToolName.make("getDocument"), enabled: true, decision: "allow" },
        { connection: userConnection, tool: ToolName.make("search"), enabled: true, decision: "allow" }
      ]
    }))
    await run(store.createBinding({
      id: newClientToolBindingId(),
      tenantId: defaultTenantId,
      clientId: client.id,
      alias: Alias.make("gmail-work"),
      tool: ToolName.make("search"),
      connection: userConnection,
    }))

    await run(store.revokeBinding(defaultTenantId, binding.id))

    expect((await run(invoke(store, key.secret))).status).toBe("not-authorized")
    expect((await run(invoke(store, key.secret, "gmail-work", "search"))).status).toBe("authorized")
  })

  test("two clients hold different policies over the same connection", async () => {
    const store = await run(makeStore())
    const { key: readerKey } = await run(seed(store))
    const writerPolicy = await run(store.createPolicy({
      id: newPolicyId(), tenantId: defaultTenantId, name: "writer"
    }))
    const writer = await run(store.createClient({
      id: newClientId(),
      tenantId: defaultTenantId,
      policyId: writerPolicy.id,
      name: "sales-campaign",
      capabilities: ["provision_connections"]
    }))
    const writerKey = generateApiKey()
    await run(store.addApiKey({ id: writerKey.id, clientId: writer.id, hash: writerKey.hash }))
    await run(store.replacePolicyConfiguration(writer.policyId, {
      integrations: [orgConnection.integration],
      tools: [{
        connection: orgConnection,
        tool: ToolName.make("getDocument"),
        enabled: true,
        decision: "require_approval"
      }]
    }))
    await run(store.createBinding({
      id: newClientToolBindingId(),
      tenantId: defaultTenantId,
      clientId: writer.id,
      alias: Alias.make("sharepoint-app"),
      tool: ToolName.make("getDocument"),
      connection: orgConnection,
    }))

    const reader = await run(invoke(store, readerKey.secret))
    const campaign = await run(invoke(store, writerKey.secret))

    expect(reader.status).toBe("authorized")
    expect(campaign.status).toBe("authorized")
    if (reader.status !== "authorized" || campaign.status !== "authorized") return
    // Same connection, same tool, different policy — which is the whole point of
    // keying policy by client rather than by connection.
    expect(reader.decision).toBe("allow")
    expect(campaign.decision).toBe("require_approval")
  })

  test("one client exposes two connections to the same integration side by side", async () => {
    const store = await run(makeStore())
    const { client, key } = await run(seed(store))
    const personal = {
      owner: "user",
      subject: SubjectId.make("sebastian"),
      integration: IntegrationSlug.make("sharepoint"),
      name: ConnectionName.make("personal")
    } as const
    // The same operation on two credentials, judged separately: the shared
    // application connection is allowed outright, the personal one is not.
    await run(store.replacePolicyConfiguration(client.policyId, {
      integrations: [orgConnection.integration],
      tools: [
        { connection: orgConnection, tool: ToolName.make("getDocument"), enabled: true, decision: "allow" },
        { connection: personal, tool: ToolName.make("getDocument"), enabled: true, decision: "require_approval" }
      ]
    }))
    await run(store.createBinding({
      id: newClientToolBindingId(),
      tenantId: defaultTenantId,
      clientId: client.id,
      alias: Alias.make("sharepoint-me"),
      tool: ToolName.make("getDocument"),
      connection: personal
    }))

    const application = await run(invoke(store, key.secret, "sharepoint-app"))
    const delegated = await run(invoke(store, key.secret, "sharepoint-me"))

    expect(application.status).toBe("authorized")
    expect(delegated.status).toBe("authorized")
    if (application.status !== "authorized" || delegated.status !== "authorized") return
    expect(application.subject).toBeNull()
    expect(delegated.subject).toBe(SubjectId.make("sebastian"))
    expect(application.decision).toBe("allow")
    expect(delegated.decision).toBe("require_approval")
  })

  test("records when a key was last used", async () => {
    const store = await run(makeStore())
    const { client, key } = await run(seed(store))
    expect((await run(store.listApiKeys(client.id)))[0]?.lastUsedAt).toBeNull()

    await run(invoke(store, key.secret))

    expect((await run(store.listApiKeys(client.id)))[0]?.lastUsedAt).not.toBeNull()
  })
})

describe("gateway capability authorization", () => {
  test("permits a key whose client holds the requested capability", async () => {
    const store = await run(makeStore())
    const { key } = await run(seed(store, { capabilities: ["provision_connections", "administer_gateway"] }))

    expect((await run(authorizeClientCapability(
      store,
      key.secret,
      "administer_gateway"
    ))).status).toBe("authorized")
  })

  test("refuses a key whose client may not, before any human is asked", async () => {
    const store = await run(makeStore())
    const { key } = await run(seed(store, { capabilities: ["provision_connections"] }))

    // The request is not makeable, so there is no approval prompt to wave
    // through — which is the point of a static capability over a runtime gate.
    expect((await run(authorizeClientCapability(
      store,
      key.secret,
      "administer_gateway"
    ))).status).toBe("not-permitted")
  })

  test("refuses unknown and revoked credentials", async () => {
    const store = await run(makeStore())
    const { client, key } = await run(seed(store, { capabilities: ["provision_connections", "administer_gateway"] }))

    expect((await run(authorizeClientCapability(
      store,
      "wfi_nope",
      "administer_gateway"
    ))).status).toBe("unknown-key")

    await run(store.revokeClient(defaultTenantId, client.id))
    expect((await run(authorizeClientCapability(
      store,
      key.secret,
      "administer_gateway"
    ))).status).toBe("client-revoked")
  })
})
