import { run, runAll } from "./effect.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { whenPresent } from "@mokronos/contracts"
import {
  createGatewayHandler,
  createGatewayStore,
  defaultTenantId,
  generateApiKey,
  GatewayStoreError,
  newClientId
} from "../src/index.ts"
import type { GatewayStore } from "../src/index.ts"
import { stubIntegrations } from "./stubs.ts"

const directories: Array<string> = []
const stores: Array<GatewayStore> = []

afterEach(async () => {
  await runAll(stores.splice(0).map((store) => store.close()))
  await run(Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  ))
})

/** The message a broken driver would carry: the kind of detail that must reach
 *  the log and must not reach the caller. */
const driverFailure = "SQLITE_BUSY: database is locked at /srv/secrets/gateway.sqlite"

const setup = async (options: {
  readonly listClientsFails?: boolean
  readonly unreachableUrl?: boolean
} = {}) => {
  const directory = await run(mkdtemp(path.join(tmpdir(), "wf-failures-")))
  directories.push(directory)
  const store = await run(createGatewayStore(path.join(directory, "gateway.sqlite")))
  stores.push(store)

  const client = await run(store.createClient({
    id: newClientId(),
    tenantId: defaultTenantId,
    name: "operator",
    capabilities: ["administer_gateway", "provision_connections"]
  }))
  const key = generateApiKey()
  await run(store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash }))

  // A store whose one method rejects, standing in for any driver-level failure
  // no handler declared.
  const presented: GatewayStore = options.listClientsFails === true
    ? {
      ...store,
      listClients: () => Effect.fail(new GatewayStoreError({
        operation: "listClients",
        cause: new Error(driverFailure)
      }))
    }
    : store

  // A host whose fetch of the caller's URL fails the way an unreachable one does.
  const integrations = stubIntegrations()
  const presentedIntegrations = options.unreachableUrl === true
    ? {
      ...integrations,
      provisioning: {
        ...integrations.provisioning,
        provision: () => Promise.reject(new Error("fetch failed"))
      }
    }
    : integrations

  const { handle } = createGatewayHandler({
    store: presented,
    integrations: presentedIntegrations,
    retentionDays: 30,
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
    expect(await run(response.json())).toEqual({
      error: "The gateway could not complete this request"
    })
  })

  test("says nothing about the database that broke", async () => {
    const { call } = await run(setup({ listClientsFails: true }))
    const body = await run((await run(call("GET", "/v1/clients"))).text())
    expect(body).not.toContain("SQLITE")
    expect(body).not.toContain("/srv/secrets")
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
