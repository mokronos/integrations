import { makeGatewayEvents } from "@integragents/gateway-core"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema, Tracer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { whenPresent, whenPresentMap } from "@integragents/contracts"
import { McpError, SpecError } from "@integragents/host"
import { recordingTracer } from "@integragents/observability"
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
  readonly errorCapture?: (operation: string | undefined) => void
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
    events: yield* makeGatewayEvents,
    httpClient: FetchHttpClient.layer,
    telemetry: Layer.succeed(Tracer.Tracer, recordingTracer(Tracer.nativeTracer, "gateway", () => {})),
    integrationServices: stubIntegrationsContext({}, unreachable),
    store: presented,
    retentionDays: 30,
    ...whenPresentMap("errorCapture", options.errorCapture, (sink) => ({
      captureException: (_cause, context) => Effect.sync(() => sink(context.operation))
    })),
    oauth: {
      start: () => Effect.die(new Error("not used")),
      provideClient: () => Effect.sync((): undefined => undefined),
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
  it.effect("answers in the gateway's own dialect, saying nothing about the database that broke", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({ listClientsFails: true })

      const response = yield* call("GET", "/v1/clients")

      expect(response.status).toBe(500)
      const body = yield* Effect.promise(() => response.text())
      expect(JSON.parse(body)).toMatchObject({
        _tag: "GatewayFailure",
        message: "The gateway could not complete this request"
      })
      expect(body).not.toContain("SQLITE")
      expect(body).not.toContain("/srv/secrets")
    }).pipe(Effect.provide(testServices)))

  it.effect("tells the sink which operation rejected and hands the caller the request's trace id", () =>
    Effect.gen(function*() {
      const recorded: Array<string | undefined> = []
      const { call } = yield* setup({
        listClientsFails: true,
        errorCapture: (operation) => {
          recorded.push(operation)
        }
      })

      const first = yield* bodyOf(yield* call("GET", "/v1/clients"))
      const second = yield* bodyOf(yield* call("GET", "/v1/clients"))

      expect(recorded).toEqual(["listClients", "listClients"])
      expect(first["traceId"]).toMatch(/^[0-9a-f]{32}$/)
      expect(second["traceId"]).not.toBe(first["traceId"])
    }).pipe(Effect.provide(testServices)))
})

describe("failures out at the far end", () => {
  it.effect("a URL that cannot be read is the caller's 400, not the gateway's 500", () =>
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
