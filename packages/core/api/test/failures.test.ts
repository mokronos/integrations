import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { whenPresent, whenPresentMap } from "@integrations/contracts"
import { McpError, SpecError } from "@integrations/integrations"
import {
  createGatewayHandler,
  defaultTenantId,
  generateApiKey,
  GatewayStoreError,
  newClientId
} from "./gateway.ts"
import type { GatewayStore } from "./gateway.ts"
import { stubIntegrationsContext } from "./stubs.ts"
import { gatewayStore, testServices } from "./fixtures.ts"

const JsonBody = Schema.Record(Schema.String, Schema.Json)

const bodyOf = (response: Response) =>
  Effect.map(
    Effect.promise(() => response.json()),
    Schema.decodeUnknownSync(JsonBody)
  )

const driverFailure = "SQLITE_BUSY: database is locked at /srv/secrets/gateway.sqlite"

const setup = Effect.fnUntraced(function*(options: {
  readonly listClientsFails?: boolean
  readonly unreachableUrl?: boolean
  readonly errorCapture?: (operation: string | undefined) => string
} = {}) {
  const store = yield* gatewayStore("gateway-failures-")
  const accessProfile = yield* store.findDefaultAccessProfile(defaultTenantId)
  const approvalPolicy = yield* store.findDefaultApprovalPolicy(defaultTenantId)
  if (accessProfile === undefined || approvalPolicy === undefined) {
    throw new Error("missing defaults")
  }

  const client = yield* store.createClient({
    id: yield* newClientId,
    tenantId: defaultTenantId,
    accessProfileId: accessProfile.id,
    approvalPolicyId: approvalPolicy.id,
    name: "operator",
    capabilities: ["administer_gateway", "provision_connections"]
  })
  const key = yield* generateApiKey
  yield* store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash })

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
        probe: (endpoint: string) => Effect.fail(new McpError({ endpoint, detail: "fetch failed" }))
      },
      specs: {
        compileUrl: (url: string) => Effect.fail(new SpecError({ source: url, detail: "fetch failed" }))
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
    Effect.promise(() =>
      handle(new Request(`http://gateway.test${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${key.secret}`,
          ...whenPresent("content-type", body === undefined ? undefined : "application/json")
        },
        ...whenPresent("body", body)
      })))

  return { call }
})

describe("failures nobody declared", () => {
  it.live("answers in the gateway's own dialect, saying nothing about the database that broke", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({ listClientsFails: true })

      const response = yield* call("GET", "/v1/clients")

      expect(response.status).toBe(500)
      const body = yield* Effect.promise(() => response.text())
      expect(JSON.parse(body).error).toBe("The gateway could not complete this request")
      expect(body).not.toContain("SQLITE")
      expect(body).not.toContain("/srv/secrets")
    }).pipe(Effect.provide(testServices)))

  it.live("tells the sink which operation rejected and hands the caller back its id", () =>
    Effect.gen(function*() {
      const recorded: Array<{ readonly traceId: string; readonly operation?: string }> = []
      const { call } = yield* setup({
        listClientsFails: true,
        errorCapture: (operation) => {
          const traceId = `trace-${recorded.length}`
          recorded.push({ traceId, ...whenPresent("operation", operation) })
          return traceId
        }
      })

      const body = yield* bodyOf(yield* call("GET", "/v1/clients"))

      expect(recorded).toEqual([{ traceId: "trace-0", operation: "listClients" }])
      expect(body["traceId"]).toBe("trace-0")

      const anonymous = yield* setup({ listClientsFails: true, errorCapture: () => "" })
      expect(yield* bodyOf(yield* anonymous.call("GET", "/v1/clients")))
        .toEqual({ error: "The gateway could not complete this request" })
    }).pipe(Effect.provide(testServices)))
})

describe("failures out at the far end", () => {
  it.live("a URL that cannot be read is the caller's 400, not the gateway's 500", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({ unreachableUrl: true })

      const response = yield* call(
        "POST",
        "/v1/integrations/discover",
        JSON.stringify({ url: "https://127.0.0.1:9/openapi.json" })
      )

      expect(response.status).toBe(400)
      const body = yield* bodyOf(response)
      expect(String(body["error"])).toContain("https://127.0.0.1:9/openapi.json")
      expect(String(body["error"])).toContain("fetch failed")
    }).pipe(Effect.provide(testServices)))
})
