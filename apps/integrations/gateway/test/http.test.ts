import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import type { ExecutorServices } from "@mokronos/wfkit-executor"
import {
  Alias,
  ClientId,
  ConnectionName,
  createGatewayHandler,
  createGatewayStore,
  generateApiKey,
  IntegrationSlug,
  makeRoutes,
  newClientId,
  newGrantId,
  SubjectId,
  ToolName
} from "../src/index.ts"
import type { ConnectionRef, GatewayStore } from "../src/index.ts"

const directories: Array<string> = []
const stores: Array<GatewayStore> = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

const connection: ConnectionRef = {
  owner: "user",
  subject: SubjectId.make("sebastian"),
  integration: IntegrationSlug.make("gmail"),
  name: ConnectionName.make("work")
}

interface ExecutedCall {
  readonly address: string
  readonly input: unknown
}

/** A stand-in for the Executor tool surface. The gateway's job is deciding
 *  whether a call happens and with which credential — not what the vendor
 *  returns — so the tests assert on which address was reached. */
const stubExecutor = (behaviour: { readonly fail?: boolean } = {}) => {
  const calls: Array<ExecutedCall> = []
  const executor = {
    tools: {
      execute: async (address: string, input: unknown) => {
        calls.push({ address, input })
        if (behaviour.fail === true) throw new Error("vendor exploded")
        return { ok: true } as typeof Schema.Json.Type
      },
      summaries: async () => [],
      describe: async () => ({}),
      list: async () => []
    },
    connections: { list: async () => [], remove: async () => undefined },
    provisioning: { provision: async () => ({ installed: true }) },
    listIntegrationOverviews: async () => []
  }
  return { calls, executor: executor as unknown as ExecutorServices }
}

const setup = async (options: {
  readonly decision?: "allow" | "require_approval"
  readonly mayMutate?: boolean
  readonly fail?: boolean
} = {}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "wf-gateway-http-"))
  directories.push(directory)
  const store = await createGatewayStore(path.join(directory, "gateway.sqlite"))
  stores.push(store)

  const client = await store.createClient({
    id: newClientId(),
    name: "support-agent",
    mayMutate: options.mayMutate ?? false
  })
  const key = generateApiKey()
  await store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash })
  const grant = await store.createGrant({
    id: newGrantId(),
    clientId: client.id,
    alias: Alias.make("gmail-work"),
    tool: ToolName.make("sendEmail"),
    connection,
    decision: options.decision ?? "allow"
  })

  const stub = stubExecutor(options.fail === undefined ? {} : { fail: options.fail })
  const handle = createGatewayHandler({
    store,
    routes: makeRoutes({
      store,
      executor: stub.executor,
      retentionDays: 30,
      // No OAuth flow is exercised here; these tests are about authority.
      oauth: {
        start: async () => { throw new Error("not used") },
        get: () => undefined,
        stop: () => undefined
      }
    })
  })

  const call = async (
    method: string,
    pathname: string,
    init: { readonly body?: unknown; readonly secret?: string | null } = {}
  ) => {
    const headers: Record<string, string> = { "content-type": "application/json" }
    const secret = init.secret === undefined ? key.secret : init.secret
    if (secret !== null) headers["authorization"] = `Bearer ${secret}`
    const response = await handle(new Request(`http://gateway.test${pathname}`, {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    }))
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }

  return { store, client, key, grant, call, calls: stub.calls }
}

describe("gateway http surface", () => {
  test("serves health without a key", async () => {
    const { call } = await setup()
    const response = await call("GET", "/v1/health", { secret: null })
    expect(response.status).toBe(200)
  })

  test("requires a key on every other route", async () => {
    const { call } = await setup()
    expect((await call("GET", "/v1/tools", { secret: null })).status).toBe(401)
  })

  test("rejects an unknown key with 401 and a revoked client with 403", async () => {
    const { call, client, store } = await setup()
    expect((await call("GET", "/v1/tools", { secret: "wfi_nope" })).status).toBe(401)

    await store.revokeClient(client.id)
    expect((await call("GET", "/v1/tools")).status).toBe(403)
  })

  test("distinguishes an unknown path from a wrong method", async () => {
    const { call } = await setup()
    expect((await call("GET", "/v1/nothing")).status).toBe(404)
    expect((await call("DELETE", "/v1/tools")).status).toBe(405)
  })

  test("lists only the tools the caller was granted", async () => {
    const { call } = await setup()
    const response = await call("GET", "/v1/tools")
    expect(response.status).toBe(200)
    expect(response.body["tools"]).toEqual([
      { alias: "gmail-work", tool: "sendEmail", integration: "gmail", decision: "allow" }
    ])
  })

  test("executes a granted tool against the address built from the grant", async () => {
    const { call, calls } = await setup()

    const response = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail", arguments: { to: "a@b.c" } }
    })

    expect(response.status).toBe(200)
    expect(response.body["status"]).toBe("succeeded")
    // The address is derived from the grant, so a caller cannot forge one.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.address).toBe("tools.gmail.user.work.sendEmail")
  })

  test("refuses an ungranted tool without calling the vendor", async () => {
    const { call, calls } = await setup()

    const response = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "deleteEverything" }
    })

    expect(response.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  test("freezes a require_approval call instead of performing it", async () => {
    const { call, calls } = await setup({ decision: "require_approval" })

    const response = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail", arguments: { to: "a@b.c" } }
    })

    expect(response.status).toBe(200)
    expect(response.body["status"]).toBe("pending")
    expect(response.body["approvalId"]).toBeString()
    // Nothing reached the vendor: the call is frozen, not attempted.
    expect(calls).toHaveLength(0)
  })

  test("reports a vendor failure as 502 rather than a denial", async () => {
    const { call } = await setup({ fail: true })

    const response = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail" }
    })

    expect(response.status).toBe(502)
    expect(response.body["status"]).toBe("failed")
  })

  test("rejects a malformed body at the boundary", async () => {
    const { call } = await setup()
    const response = await call("POST", "/v1/execute", { body: { alias: "gmail-work" } })
    expect(response.status).toBe(400)
  })

  test("refuses privileged routes to a key that may not mutate", async () => {
    const { call } = await setup({ mayMutate: false })

    for (const [method, route] of [
      ["GET", "/v1/integrations"],
      ["POST", "/v1/integrations/discover"],
      ["GET", "/v1/connections"],
      ["GET", "/v1/clients"],
      ["POST", "/v1/clients"],
      ["GET", "/v1/grants?clientId=x"],
      ["POST", "/v1/grants"],
      ["GET", "/v1/approvals"],
      ["GET", "/v1/audit"]
    ] as const) {
      const response = await call(method, route, { body: {} })
      expect(`${route} -> ${response.status}`).toBe(`${route} -> 403`)
    }
  })

  test("permits the same routes to a key that may mutate", async () => {
    const { call } = await setup({ mayMutate: true })
    expect((await call("GET", "/v1/integrations")).status).toBe(200)
    expect((await call("GET", "/v1/clients")).status).toBe(200)
    expect((await call("GET", "/v1/audit")).status).toBe(200)
  })

  test("does not let one client read another's frozen call", async () => {
    const { call, store, client } = await setup({ decision: "require_approval" })
    const frozen = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail" }
    })
    const approvalId = String(frozen.body["approvalId"])

    const other = await store.createClient({
      id: newClientId(),
      name: "someone-else",
      mayMutate: false
    })
    const otherKey = generateApiKey()
    await store.addApiKey({ id: otherKey.id, clientId: other.id, hash: otherKey.hash })

    expect((await call("GET", `/v1/approvals/${approvalId}`)).status).toBe(200)
    const peek = await call("GET", `/v1/approvals/${approvalId}`, { secret: otherKey.secret })
    // Reported as absent rather than forbidden, so existence does not leak.
    expect(peek.status).toBe(404)
    expect(client.id).not.toBe(other.id)
  })

  test("issues a key exactly once and never returns it again", async () => {
    const { call, store } = await setup({ mayMutate: true })
    const clientResponse = await call("POST", "/v1/clients", { body: { name: "sandbox" } })
    expect(clientResponse.status).toBe(201)
    const clientId = ClientId.make(String(clientResponse.body["id"]))

    const keyResponse = await call("POST", `/v1/clients/${clientId}/keys`, { body: {} })
    expect(keyResponse.status).toBe(201)
    const secret = String(keyResponse.body["secret"])
    expect(secret).toStartWith("wfi_")

    const stored = await store.listApiKeys(clientId)
    expect(JSON.stringify(stored)).not.toContain(secret)
  })

  test("a new client defaults to not being able to mutate", async () => {
    const { call } = await setup({ mayMutate: true })
    const response = await call("POST", "/v1/clients", { body: { name: "sandbox" } })
    expect(response.body["mayMutate"]).toBe(false)
  })

  test("revoking a client through the API cancels its frozen calls", async () => {
    const { call, client } = await setup({ decision: "require_approval", mayMutate: true })
    await call("POST", "/v1/execute", { body: { alias: "gmail-work", tool: "sendEmail" } })

    const response = await call("POST", `/v1/clients/${client.id}/revoke`, { body: {} })

    expect(response.status).toBe(200)
    expect(response.body["cancelledApprovals"]).toBe(1)
  })
})

describe("gateway approval settlement", () => {
  test("the gateway performs the call itself once approved", async () => {
    const { call, calls } = await setup({ decision: "require_approval", mayMutate: true })
    const frozen = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail", arguments: { to: "a@b.c" } }
    })
    const approvalId = String(frozen.body["approvalId"])
    expect(calls).toHaveLength(0)

    const approved = await call("POST", `/v1/approvals/${approvalId}/approve`, {
      body: { decidedBy: "sebastian" }
    })

    expect(approved.status).toBe(200)
    // Approving discharges one frozen invocation. The caller was never handed
    // the capability, and the frozen arguments are what ran.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toEqual({ to: "a@b.c" })
  })

  test("refuses to approve twice", async () => {
    const { call } = await setup({ decision: "require_approval", mayMutate: true })
    const frozen = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail" }
    })
    const approvalId = String(frozen.body["approvalId"])

    expect((await call("POST", `/v1/approvals/${approvalId}/approve`, { body: {} })).status).toBe(200)
    expect((await call("POST", `/v1/approvals/${approvalId}/approve`, { body: {} })).status).toBe(400)
  })

  test("refuses to approve a call whose grant was revoked while frozen", async () => {
    const { call, store, grant, calls } = await setup({
      decision: "require_approval",
      mayMutate: true
    })
    const frozen = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail" }
    })
    const approvalId = String(frozen.body["approvalId"])

    await store.revokeGrant(grant.id)
    const approved = await call("POST", `/v1/approvals/${approvalId}/approve`, { body: {} })

    expect(approved.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test("denying settles without performing the call", async () => {
    const { call, calls } = await setup({ decision: "require_approval", mayMutate: true })
    const frozen = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail" }
    })
    const approvalId = String(frozen.body["approvalId"])

    const denied = await call("POST", `/v1/approvals/${approvalId}/deny`, {
      body: { decidedBy: "sebastian" }
    })

    expect(denied.status).toBe(200)
    expect(calls).toHaveLength(0)
  })
})
