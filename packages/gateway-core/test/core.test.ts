import { describe, expect, it } from "@effect/vitest"
import path from "node:path"
import { Effect, Layer } from "effect"
import { BlobStore, defaultUrlPolicy, Egress, Integrations } from "@integragents/integrations"
import type { HostToolInvocation } from "@integragents/integrations"
import {
  aliasForConnection,
  approveApproval,
  ConnectionName,
  coreInvokeDependencies,
  defaultTenantId,
  gatewayCoreLayer,
  GatewayStoreService,
  IntegrationSlug,
  invokeAsProfile,
  libsqlLayer,
  newProfileId,
  registerHostIntegration,
  ToolName,
  unattributedOrigin
} from "../src/index.ts"
import type { ApprovalDecided, GatewayCoreOptions } from "../src/index.ts"
import { temporaryDirectory, testEncryption, testServices } from "./fixtures.ts"

type Json = typeof import("effect").Schema.Json.Type

const sandbox = IntegrationSlug.make("sandbox")
const runCommand = ToolName.make("run_command")
const connection = { owner: "org" as const, integration: sandbox, name: ConnectionName.make("default") }

/** The gateway core as an embedding host opens it: its own database, its executor, its hooks. */
const embedded = (options: Pick<GatewayCoreOptions, "hostTools" | "onApprovalDecided" | "reviewer">) =>
  Layer.unwrap(
    Effect.map(temporaryDirectory("gateway-core-"), (directory) =>
      gatewayCoreLayer({
        encryption: testEncryption,
        blobs: BlobStore.sqlLayer,
        maintenance: false,
        ...options
      }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(libsqlLayer(path.join(directory, "gateway.sqlite")), Egress.layer(defaultUrlPolicy))
        )
      )
    )
  ).pipe(Layer.provideMerge(testServices))

describe("an embedding host", () => {
  it.effect("runs its own tool behind an approval and hears when the approval was decided", () => {
    const seen: Array<HostToolInvocation> = []
    const decided: Array<ApprovalDecided> = []
    return Effect.gen(function* () {
      const store = yield* GatewayStoreService
      const integrations = yield* Integrations
      yield* registerHostIntegration({
        store,
        integrations,
        definition: {
          slug: sandbox,
          name: "Sandbox",
          tools: [{ name: runCommand, description: "Run a shell command" }]
        }
      })
      const profile = yield* store.createProfile({
        id: yield* newProfileId,
        tenantId: defaultTenantId,
        name: "vm-agent",
        capabilities: [],
        tools: [{ connection, tool: runCommand, decision: "require_approval" }]
      })

      const pending = yield* invokeAsProfile(
        { store, integrations },
        {
          profile,
          origin: unattributedOrigin,
          alias: aliasForConnection(connection),
          tool: runCommand,
          arguments: { command: "uptime" }
        }
      )
      if (pending.status !== "pending") return yield* Effect.die(`expected pending, got ${pending.status}`)
      yield* approveApproval(
        { store, integrations, retentionDays: 30 },
        { tenantId: defaultTenantId, id: pending.approvalId, decidedBy: "ann" }
      )

      expect(seen.map((call) => call.arguments)).toEqual([{ command: "uptime" }])
      expect(decided.map((event) => [event.approvalId, event.status, event.outcome])).toEqual([
        [pending.approvalId, "approved", { status: "succeeded", result: "up 3 days" }]
      ])
    }).pipe(
      Effect.provide(
        embedded({
          hostTools: {
            execute: (invocation) =>
              Effect.sync((): Json => {
                seen.push(invocation)
                return "up 3 days"
              })
          },
          onApprovalDecided: (event) =>
            Effect.sync(() => {
              decided.push(event)
            })
        })
      )
    )
  })

  it.effect("has the reviewer it gave the core layer judge the calls it makes", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const store = yield* GatewayStoreService
      const integrations = yield* Integrations
      yield* registerHostIntegration({
        store,
        integrations,
        definition: {
          slug: sandbox,
          name: "Sandbox",
          tools: [{ name: runCommand, description: "Run a shell command" }]
        }
      })
      const profile = yield* store.createProfile({
        id: yield* newProfileId,
        tenantId: defaultTenantId,
        name: "vm-agent",
        capabilities: [],
        tools: [{ connection, tool: runCommand, decision: "require_approval" }]
      })

      const outcome = yield* invokeAsProfile(yield* coreInvokeDependencies(), {
        profile,
        origin: unattributedOrigin,
        alias: aliasForConnection(connection),
        tool: runCommand,
        arguments: { command: "shutdown now" }
      })

      expect(outcome.status === "denied" ? outcome.reason : outcome.status).toContain("reviewer:guard")
      expect(seen).toEqual([])
    }).pipe(
      Effect.provide(
        embedded({
          hostTools: {
            execute: (invocation) =>
              Effect.sync((): Json => {
                seen.push(invocation)
                return null
              })
          },
          reviewer: { name: "guard", review: () => Effect.succeed({ verdict: "deny", reason: "no shutdowns" }) }
        })
      )
    )
  })
})
