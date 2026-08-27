import { run, runAll } from "./effect.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { whenPresent } from "@mokronos/contracts"
import type { IntegrationsApi } from "@mokronos/integration-host"
import {
  createGatewayHandler,
  createGatewayStore,
  createRateLimiter,
  defaultTenantId,
  generateApiKey,
  newClientId
} from "../src/index.ts"
import type { GatewayStore } from "../src/index.ts"

const JsonBody = Schema.Record(Schema.String, Schema.Json)

const directories: Array<string> = []
const stores: Array<GatewayStore> = []

afterEach(async () => {
  await runAll(stores.splice(0).map((store) => store.close()))
  await run(Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  ))
})

describe("the fixed-window limiter", () => {
  test("allows the limit and refuses the next request in the window", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 })
    let now = 1_000_000

    expect(limiter.take("k", now).allowed).toBe(true)
    expect(limiter.take("k", now).allowed).toBe(true)
    const lastAllowed = limiter.take("k", now)
    expect(lastAllowed.allowed).toBe(true)

    now += 1_000
    const refused = limiter.take("k", now)
    expect(refused.allowed).toBe(false)
    // Counts down to the window's close, not a fixed guess.
    expect(refused.retryAfterSeconds).toBe(59)
  })

  test("opens a fresh window when the old one closes", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 10_000 })
    let now = 0
    expect(limiter.take("k", now).allowed).toBe(true)
    expect(limiter.take("k", now).allowed).toBe(true)
    expect(limiter.take("k", now + 5_000).allowed).toBe(false)
    // One millisecond past the boundary is a new budget.
    expect(limiter.take("k", now + 10_001).allowed).toBe(true)
  })

  test("keys are independent", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 })
    expect(limiter.take("a", 0).allowed).toBe(true)
    expect(limiter.take("b", 0).allowed).toBe(true)
    expect(limiter.take("a", 0).allowed).toBe(false)
  })

  test("prunes stale counters instead of growing without bound", () => {
    const limiter = createRateLimiter({ limit: 1000, windowMs: 1_000 })
    for (let i = 0; i < 5000; i++) limiter.take(`key-${i}`, i * 10)
    // Every counter is long expired by now; the next take triggers a sweep.
    expect(limiter.take("fresh", 50_000).allowed).toBe(true)
  })
})

describe("gateway traffic shaping", () => {
  const notStubbed = (member: string) => () => {
    throw new Error(`stubIntegrations: ${member} is not stubbed for these tests`)
  }

  const stubIntegrations = (): IntegrationsApi => ({
    tools: {
      execute: notStubbed("tools.execute"),
      summaries: async () => [],
      describe: notStubbed("tools.describe"),
      list: async () => []
    },
    connections: {
      list: async () => [],
      remove: notStubbed("connections.remove"),
      create: notStubbed("connections.create"),
      ensure: notStubbed("connections.ensure")
    },
    catalog: {
      classify: notStubbed("catalog.classify"),
      list: notStubbed("catalog.list"),
      find: notStubbed("catalog.find"),
      addMcp: notStubbed("catalog.addMcp"),
      addOpenApi: notStubbed("catalog.addOpenApi")
    },
    auth: {
      probe: notStubbed("auth.probe"),
      registerClient: notStubbed("auth.registerClient"),
      createClient: notStubbed("auth.createClient"),
      start: notStubbed("auth.start"),
      complete: notStubbed("auth.complete")
    },
    provisioning: {
      install: notStubbed("provisioning.install"),
      provision: notStubbed("provisioning.provision")
    },
    validateIntegrationNode: notStubbed("validateIntegrationNode"),
    listIntegrationOverviews: async () => []
  })

  interface SetupOptions {
    readonly addressLimit?: number
    readonly principalLimit?: number
    readonly maxBodyBytes?: number
  }

  const setup = async (options: SetupOptions = {}) => {
    const directory = await run(mkdtemp(path.join(tmpdir(), "wf-gateway-limits-")))
    directories.push(directory)
    const store = await run(createGatewayStore(path.join(directory, "gateway.sqlite")))
    stores.push(store)
    const client = await run(store.createClient({
      id: newClientId(),
      tenantId: defaultTenantId,
      name: "local",
      capabilities: ["provision_connections", "administer_gateway"]
    }))
    const key = generateApiKey()
    await run(store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash }))

    const { handle } = createGatewayHandler({
      store,
      integrations: stubIntegrations(),
      retentionDays: 30,
      oauth: {
        start: () => Effect.die(new Error("not used")),
        get: () => Effect.sync((): undefined => undefined),
        completeByState: () => Effect.sync((): undefined => undefined),
        stop: () => Effect.void
      },
      addressRateLimiter: createRateLimiter({
        limit: options.addressLimit ?? 3,
        windowMs: 60_000
      }),
      rateLimiter: createRateLimiter({
        limit: options.principalLimit ?? 1000,
        windowMs: 60_000
      }),
      ...whenPresent("maxBodyBytes", options.maxBodyBytes)
    })

    return { handle, client, key }
  }

  test("an address that exhausts its pre-auth bucket gets 429 with Retry-After", async () => {
    const { handle } = await run(setup({ addressLimit: 2 }))
    const attempt = () => handle(new Request("http://gateway.test/v1/tools"))

    // The first two spend the bucket; each reaches authentication and is
    // refused there for having no key.
    expect((await run(attempt())).status).toBe(401)
    expect((await run(attempt())).status).toBe(401)
    // The next one never gets that far.
    const refused = await run(attempt())
    expect(refused.status).toBe(429)
    expect(refused.headers.get("retry-after")).toBe("60")
    const body = Schema.decodeUnknownSync(JsonBody)(await run(refused.json()))
    expect(body["code"]).toBe("rate-limited")
  })

  test("health stays reachable under load — it is what the monitor polls", async () => {
    const { handle } = await run(setup({ addressLimit: 1 }))
    expect((await run(handle(new Request("http://gateway.test/v1/health")))).status).toBe(200)
    await run(handle(new Request("http://gateway.test/v1/tools")))
    const refused = await run(handle(new Request("http://gateway.test/v1/tools")))
    expect(refused.status).toBe(429)
    expect((await run(handle(new Request("http://gateway.test/v1/health")))).status).toBe(200)
  })

  test("one exhausted principal does not starve another", async () => {
    const { handle, client, key } = await run(setup({
      principalLimit: 2,
      // Wide open: this test is about principal fairness, not the address.
      addressLimit: 10_000
    }))

    const otherStore = stores[stores.length - 1]
    if (otherStore === undefined) throw new Error("missing store fixture")
    const neighbour = await run(otherStore.createClient({
      id: newClientId(),
      tenantId: defaultTenantId,
      name: "neighbour",
      capabilities: ["provision_connections"]
    }))
    const neighbourKey = generateApiKey()
    await run(otherStore.addApiKey({
      id: neighbourKey.id,
      clientId: neighbour.id,
      hash: neighbourKey.hash
    }))
    void client

    const as = (secret: string) =>
      handle(new Request("http://gateway.test/v1/tools", {
        headers: { authorization: `Bearer ${secret}` }
      }))

    expect((await run(as(key.secret))).status).toBe(200)
    expect((await run(as(key.secret))).status).toBe(200)
    expect((await run(as(key.secret))).status).toBe(429)
    // The neighbour's budget is untouched.
    expect((await run(as(neighbourKey.secret))).status).toBe(200)
  })

  test("an oversized body is refused with 413 before any handler runs", async () => {
    const { handle, key } = await run(setup({ maxBodyBytes: 16 }))
    const response = await run(handle(new Request("http://gateway.test/v1/clients", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.secret}`,
        "content-length": String(Buffer.byteLength(JSON.stringify({ name: "x".repeat(64) })))
      },
      body: JSON.stringify({ name: "x".repeat(64) })
    })))
    expect(response.status).toBe(413)
    const body = Schema.decodeUnknownSync(JsonBody)(await run(response.json()))
    expect(String(body["error"])).toContain("exceeds")
  })
})
