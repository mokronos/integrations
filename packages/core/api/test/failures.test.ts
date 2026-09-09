import { FetchHttpClient } from "effect/unstable/http"
import { run, runAll } from "./effect.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { whenPresent, whenPresentMap } from "@integrations/contracts"
import {
  createGatewayHandler,
  createGatewayStore,
  defaultTenantId,
  generateApiKey,
  GatewayStoreError,
  newClientId
} from "./gateway.ts"
import type { GatewayStore } from "./gateway.ts"
import { stubIntegrationsContext } from "./stubs.ts"
import { McpError, SpecError } from "@integrations/integrations"

const directories: Array<string> = []
const stores: Array<GatewayStore> = []

afterEach(async () => {
  await runAll(stores.splice(0).map((store) => store.close()))
  await run(Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  ))
})

const driverFailure = "SQLITE_BUSY: database is locked at /srv/secrets/gateway.sqlite"

const setup = async (options: {
  readonly listClientsFails?: boolean
  readonly unreachableUrl?: boolean
  readonly errorCapture?: (operation: string | undefined) => string
} = {}) => {
  const directory = await run(mkdtemp(path.join(tmpdir(), "wf-failures-")))
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
    name: "operator",
    capabilities: ["administer_gateway", "provision_connections"]
  }))
  const key = (await run(generateApiKey))
  await run(store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash }))

  const presented: GatewayStore = options.listClientsFails === true
    ? {
      ...store,
      listClients: () => Effect.fail(new GatewayStoreError({
        operation: "listClients",
        kind: "driver",
        cause: new Error(driverFailure)
      }))
    }
    : store

  const unreachable = options.unreachableUrl === true
    ? {
      mcp: {
        probe: (endpoint: string) => Effect.fail(new McpError({
          endpoint,
          detail: "fetch failed"
        }))
      },
      specs: {
        compileUrl: (url: string) => Effect.fail(new SpecError({
          source: url,
          detail: "fetch failed"
        }))
      }
    }
    : {}

  const { handle } = createGatewayHandler({
    httpClient: FetchHttpClient.layer,
    integrationServices: stubIntegrationsContext({}, unreachable),
    store: presented,
    retentionDays: 30,
    ...whenPresentMap("errorCapture", options.errorCapture, (sink) => ({
      captureException: (_cause, context) => Effect.succeed(sink(context.operation))
    })),
    oauth: {
      start: () => Effect.die(new Error("not used")),
      get: () => Effect.sync((): undefined => undefined),
      completeByState: () => Effect.sync((): undefined => undefined),
      stop: () => Effect.void
    }
  })

  const call = (method: string, pathname: string, body?: string) =>
    handle(new Request(`http://gateway.test${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${key.secret}`,
        ...whenPresent("content-type", body === undefined ? undefined : "application/json")
      },
      ...whenPresent("body", body)
    }))
  return { call }
}

describe("failures nobody declared", () => {
  test("answers in the gateway's own dialect instead of an empty 500", async () => {
    const { call } = await run(setup({ listClientsFails: true }))
    const response = await run(call("GET", "/v1/clients"))
    expect(response.status).toBe(500)
    const body = await run(response.json())
    expect(body.error).toBe("The gateway could not complete this request")
  })

  test("says nothing about the database that broke", async () => {
    const { call } = await run(setup({ listClientsFails: true }))
    const body = await run((await run(call("GET", "/v1/clients"))).text())
    expect(body).not.toContain("SQLITE")
    expect(body).not.toContain("/srv/secrets")
  })

  test("hands back the id the failure was recorded under", async () => {
    const recorded: Array<{ readonly traceId: string; readonly operation?: string }> = []
    const { call } = await run(setup({
      listClientsFails: true,
      errorCapture: (operation) => {
        const traceId = `trace-${recorded.length}`
        recorded.push({ traceId, ...whenPresent("operation", operation) })
        return traceId
      }
    }))
    const body = await run((await run(call("GET", "/v1/clients"))).json())
    expect(recorded).toHaveLength(1)
    expect(body.traceId).toBe(recorded[0]?.traceId)
  })

  test("tells the sink which store operation rejected", async () => {
    const operations: Array<string | undefined> = []
    const { call } = await run(setup({
      listClientsFails: true,
      errorCapture: (operation) => {
        operations.push(operation)
        return "trace"
      }
    }))
    await run(call("GET", "/v1/clients"))
    expect(operations).toEqual(["listClients"])
  })

  test("a sink that keeps no id leaves the field off rather than sending an empty one", async () => {
    const { call } = await run(setup({
      listClientsFails: true,
      errorCapture: () => ""
    }))
    const body = await run((await run(call("GET", "/v1/clients"))).json())
    expect(body).toEqual({ error: "The gateway could not complete this request" })
  })

  test("still refuses a malformed request with 400, not 500", async () => {
    const { call } = await run(setup())
    const response = await run(call("POST", "/v1/clients", JSON.stringify({ nope: true })))
    expect(response.status).toBe(400)
  })
})

describe("failures out at the far end", () => {
  test("a URL that cannot be read is the caller's 400, not the gateway's 500", async () => {
    const { call } = await run(setup({ unreachableUrl: true }))
    const response = await run(call(
      "POST",
      "/v1/integrations/discover",
      JSON.stringify({ url: "https://127.0.0.1:9/openapi.json" })
    ))
    expect(response.status).toBe(400)
    const body = await run(response.json())
    expect(String(body.error)).toContain("https://127.0.0.1:9/openapi.json")
    expect(String(body.error)).toContain("fetch failed")
  })
})
