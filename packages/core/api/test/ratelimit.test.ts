import { FetchHttpClient } from "effect/unstable/http"
import { run, runAll } from "./effect.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { whenPresent } from "@integrations/contracts"
import {
  createGatewayHandler,
  createGatewayStore,
  defaultTenantId,
  generateApiKey,
  newClientId
} from "./gateway.ts"
import type { GatewayStore } from "./gateway.ts"
import { stubHostContext } from "./stubs.ts"

const JsonBody = Schema.Record(Schema.String, Schema.Json)

const directories: Array<string> = []
const stores: Array<GatewayStore> = []

afterEach(async () => {
  await runAll(stores.splice(0).map((store) => store.close()))
  await run(Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  ))
})

describe("gateway traffic shaping", () => {
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
    const accessProfile = await run(store.findDefaultAccessProfile(defaultTenantId))
    const approvalPolicy = await run(store.findDefaultApprovalPolicy(defaultTenantId))
    if (accessProfile === undefined || approvalPolicy === undefined) throw new Error("missing defaults")
    const client = await run(store.createClient({
      id: (await run(newClientId)),
      tenantId: defaultTenantId,
      accessProfileId: accessProfile.id,
      approvalPolicyId: approvalPolicy.id,
      name: "local",
      capabilities: ["provision_connections", "administer_gateway"]
    }))
    const key = (await run(generateApiKey))
    await run(store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash }))

    const { handle } = createGatewayHandler({
    httpClient: FetchHttpClient.layer,
      hostServices: stubHostContext(),
      store,
      retentionDays: 30,
      oauth: {
        start: () => Effect.die(new Error("not used")),
        get: () => Effect.sync((): undefined => undefined),
        completeByState: () => Effect.sync((): undefined => undefined),
        stop: () => Effect.void
      },
      rateLimits: {
        addressPerMinute: options.addressLimit ?? 3,
        principalPerMinute: options.principalLimit ?? 1000
      },
      ...whenPresent("maxBodyBytes", options.maxBodyBytes)
    })

    return { handle, client, key }
  }

  test("an address that exhausts its pre-auth bucket gets 429 with Retry-After", async () => {
    const { handle } = await run(setup({ addressLimit: 2 }))
    const attempt = () => handle(new Request("http://gateway.test/v1/tools"))

    expect((await run(attempt())).status).toBe(401)
    expect((await run(attempt())).status).toBe(401)
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
      addressLimit: 10_000
    }))

    const otherStore = stores[stores.length - 1]
    if (otherStore === undefined) throw new Error("missing store fixture")
    const neighbourAccessProfile = await run(otherStore.findDefaultAccessProfile(defaultTenantId))
    const neighbourApprovalPolicy = await run(otherStore.findDefaultApprovalPolicy(defaultTenantId))
    if (neighbourAccessProfile === undefined || neighbourApprovalPolicy === undefined) throw new Error("missing defaults")
    const neighbour = await run(otherStore.createClient({
      id: (await run(newClientId)),
      tenantId: defaultTenantId,
      accessProfileId: neighbourAccessProfile.id,
      approvalPolicyId: neighbourApprovalPolicy.id,
      name: "neighbour",
      capabilities: ["provision_connections"]
    }))
    const neighbourKey = (await run(generateApiKey))
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
