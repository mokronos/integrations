import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import { ConnectionName, IntegrationSlug, ProfileId, SubjectId, TenantId, ToolName } from "@integragents/contracts"
import { AuthTemplateSlug } from "../src/catalog/ids.ts"
import { HostToolError, HostTools } from "../src/host-tools.ts"
import type { HostIntegrationDefinition, HostToolInvocation } from "../src/host-tools.ts"
import { Integrations } from "../src/integrations.ts"
import { McpClient } from "../src/mcp/client.ts"
import { OpenApiInvoker } from "../src/openapi/invoke.ts"
import { stubbedLayer } from "../src/runtime.ts"

const sandbox = IntegrationSlug.make("sandbox")

const definition: HostIntegrationDefinition = {
  slug: sandbox,
  name: "Sandbox",
  description: "The user's VM",
  tools: [
    {
      name: ToolName.make("run_command"),
      description: "Run a shell command in the user's VM",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      handler: "vm.exec"
    },
    { name: ToolName.make("read_file"), description: "Read a file", readOnly: true }
  ]
}

const unusedMcp = Layer.succeed(McpClient, {
  probe: () => Effect.die("unused"),
  listTools: () => Effect.die("unused"),
  callTool: () => Effect.die("unused")
})

const catalog = stubbedLayer(Layer.mergeAll(unusedMcp, OpenApiInvoker.unavailableTestLayer))

const withExecutor = (seen: Array<HostToolInvocation>) =>
  catalog.pipe(
    Layer.provide(
      HostTools.layer({
        execute: (invocation) =>
          Effect.sync(() => {
            seen.push(invocation)
            return { ran: invocation.handler }
          })
      })
    )
  )

describe("host integrations", () => {
  it.effect("catalogs a host's tools on one org connection that needs no credential", () =>
    Effect.gen(function* () {
      const host = yield* Integrations
      yield* host.registerHostIntegration(definition)

      const integration = (yield* host.listIntegrations()).find((entry) => entry.slug === sandbox)
      const connections = yield* host.listConnections({ integration: sandbox })
      const tools = yield* host.toolSummaries({ integration: sandbox })

      expect(integration?.kind).toBe("host")
      expect(connections.map((entry) => [entry.owner, entry.name, entry.status])).toEqual([
        ["org", "default", "connected"]
      ])
      expect(
        tools.map((tool) => ({
          address: tool.address,
          defaultDecision: tool.defaultDecision,
          readOnly: tool.readOnly,
          destructive: tool.destructive,
          idempotent: tool.idempotent
        }))
      ).toEqual([
        {
          address: "tools.sandbox.org.default.read_file",
          defaultDecision: "allow",
          readOnly: true,
          destructive: false,
          idempotent: true
        },
        {
          address: "tools.sandbox.org.default.run_command",
          defaultDecision: "require_approval",
          readOnly: false,
          destructive: true,
          idempotent: false
        }
      ])
      const described = yield* host.describeTool({ integration: sandbox, name: "run_command" })
      expect(described.inputSchema).toEqual(definition.tools[0]?.inputSchema)
    }).pipe(Effect.provide(catalog))
  )

  it.effect("registering again replaces the tools, so a tool the host dropped is gone", () =>
    Effect.gen(function* () {
      const host = yield* Integrations
      yield* host.registerHostIntegration(definition)
      yield* host.registerHostIntegration({ ...definition, tools: definition.tools.slice(0, 1) })

      const tools = yield* host.toolSummaries({ integration: sandbox })
      expect(tools.map((tool) => tool.name)).toEqual(["run_command"])
    }).pipe(Effect.provide(catalog))
  )

  it.effect("runs a host tool through the host's executor with the call's context", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const host = yield* Integrations
      const [tool] = yield* host.registerHostIntegration(definition)
      if (tool === undefined) return yield* Effect.die("no tool registered")
      const context = {
        tenantId: TenantId.make("tenant"),
        profileId: ProfileId.make("profile"),
        subject: SubjectId.make("alice")
      }

      const execution = yield* host.execute(tool.address, { command: "ls" }, undefined, context)

      expect(execution).toEqual({ kind: "complete", result: { ran: "vm.exec" } })
      expect(seen).toEqual([
        {
          address: tool.address,
          integration: sandbox,
          connection: ConnectionName.make("default"),
          tool: ToolName.make("run_command"),
          handler: "vm.exec",
          arguments: { command: "ls" },
          context
        }
      ])
    }).pipe(Effect.provide(withExecutor(seen)))
  })

  it.effect("reports what the host's executor said when it could not run the tool", () =>
    Effect.gen(function* () {
      const host = yield* Integrations
      const [tool] = yield* host.registerHostIntegration(definition)
      if (tool === undefined) return yield* Effect.die("no tool registered")

      const failed = yield* Effect.result(host.execute(tool.address, { command: "ls" }))

      expect(Result.isFailure(failed) ? failed.failure.message : "ran").toBe(
        "run_command failed: vm.exec: the VM is asleep"
      )
    }).pipe(
      Effect.provide(
        catalog.pipe(
          Layer.provide(
            HostTools.layer({
              execute: (invocation) =>
                Effect.fail(new HostToolError({ handler: invocation.handler, detail: "the VM is asleep" }))
            })
          )
        )
      )
    )
  )

  it.effect("fails a host tool when no executor runs host tools", () =>
    Effect.gen(function* () {
      const host = yield* Integrations
      const [tool] = yield* host.registerHostIntegration(definition)
      if (tool === undefined) return yield* Effect.die("no tool registered")

      const failed = yield* Effect.result(host.execute(tool.address, { command: "ls" }))

      expect(Result.isFailure(failed) ? failed.failure.message : "ran").toContain("no executor")
    }).pipe(Effect.provide(catalog))
  )

  it.effect("refuses connections the host did not register and slugs another integration holds", () =>
    Effect.gen(function* () {
      const host = yield* Integrations
      yield* host.registerHostIntegration(definition)

      const connected = yield* Effect.result(
        host.createConnection({
          owner: "user:alice",
          integration: sandbox,
          name: ConnectionName.make("mine"),
          template: AuthTemplateSlug.make("none")
        })
      )
      const duplicated = yield* Effect.result(
        host.registerHostIntegration({
          ...definition,
          tools: [...definition.tools, { name: ToolName.make("read_file"), description: "again" }]
        })
      )

      expect(Result.isFailure(connected)).toBe(true)
      expect(Result.isFailure(duplicated) ? duplicated.failure.message : "registered").toContain("read_file")
    }).pipe(Effect.provide(catalog))
  )
})

describe("removing a host integration's connection", () => {
  it.effect("takes its tools with it, so none of them can run any more", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const host = yield* Integrations
      const [tool] = yield* host.registerHostIntegration(definition)
      if (tool === undefined) return yield* Effect.die("no tool registered")

      yield* host.removeConnection({ owner: "org", integration: sandbox, name: ConnectionName.make("default") })
      const ran = yield* Effect.result(host.execute(tool.address, { command: "ls" }))

      expect(yield* host.toolSummaries({ integration: sandbox })).toEqual([])
      expect(Result.isFailure(ran) ? ran.failure._tag : "ran").toBe("NotFound")
      expect(seen).toEqual([])
    }).pipe(Effect.provide(withExecutor(seen)))
  })
})
