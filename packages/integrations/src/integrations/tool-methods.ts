import { Effect, Option, Predicate } from "effect"
import { ToolName, whenPresent } from "@integragents/contracts"
import type {
  ConnectionName,
  ConnectionOwner,
  InputAnswer,
  InputRound,
  IntegrationSlug,
  Json,
  ToolAddress
} from "@integragents/contracts"
import { CatalogStore } from "../catalog/store.ts"
import { InvalidInputError, InvocationError, ToolNotFoundError } from "../errors.ts"
import { HostToolError, HostTools } from "../host-tools.ts"
import type { ToolCallContext } from "../host-tools.ts"
import { McpClient } from "../mcp/client.ts"
import { normalizeToolResult } from "../mcp/result.ts"
import { declinedInputNote } from "../mcp/unrelayable-input.ts"
import { OpenApiInvoker } from "../openapi/invoke.ts"
import type { ResolvedCredential } from "../openapi/invoke.ts"
import { mcpCredential, requireMcpServer } from "./access.ts"
import type { ConnectionAccess, IntegrationFailure } from "./access.ts"
import { toTool, toToolSummary } from "./views.ts"

/** A tool call's outcome: its result, or a round of input the tool needs first. */
export type ToolExecution =
  | { readonly kind: "complete"; readonly result: Json }
  | { readonly kind: "input-required"; readonly round: InputRound }

export interface ToolFilter {
  readonly integration?: IntegrationSlug
  readonly owner?: ConnectionOwner
  readonly connection?: ConnectionName
}

export interface ToolTarget {
  readonly integration: IntegrationSlug
  readonly name: string
  readonly connection?: ConnectionName
}

/** The provider refused the credential itself, before doing anything, so asking again with a fresh token is safe. */
const rejectsCredential = (failure: IntegrationFailure): boolean =>
  (failure._tag === "McpError" && failure.reason === "unauthorized") ||
  (failure._tag === "InvocationError" && failure.status === 401)

export const toolMethods = (access: ConnectionAccess) =>
  Effect.gen(function* () {
    const store = yield* CatalogStore
    const mcp = yield* McpClient
    const invoker = yield* OpenApiInvoker
    const hostTools = yield* Effect.serviceOption(HostTools)
    const { requireIntegration, requireConnection, resolveCredential } = access

    const listTools = Effect.fn("Integrations.listTools")(function* (filter: ToolFilter = {}) {
      const records = yield* store.listTools(filter)
      return yield* Effect.forEach(records, toTool)
    })

    const toolSummaries = Effect.fn("Integrations.toolSummaries")(function* (filter: ToolFilter = {}) {
      const records = yield* store.listTools(filter)
      return yield* Effect.forEach(records, toToolSummary)
    })

    const describeTool = Effect.fn("Integrations.describeTool")(function* (target: ToolAddress | ToolTarget) {
      if (Predicate.isString(target)) {
        const found = yield* store.findTool(target)
        if (Option.isNone(found)) {
          return yield* new ToolNotFoundError({ tool: target })
        }
        return yield* toTool(found.value)
      }
      const candidates = yield* store.listTools({
        integration: target.integration,
        ...whenPresent("connection", target.connection)
      })
      const match = candidates.find((candidate) => candidate.name === target.name)
      if (match === undefined) {
        return yield* new ToolNotFoundError({
          tool: `${target.integration}/${target.name}`
        })
      }
      return yield* toTool(match)
    })

    const execute = Effect.fn("Integrations.execute")(function* (
      address: ToolAddress,
      input: Json,
      answer?: InputAnswer,
      context: ToolCallContext = {}
    ): Effect.fn.Return<ToolExecution, IntegrationFailure> {
      const found = yield* store.findTool(address)
      if (Option.isNone(found)) {
        return yield* new ToolNotFoundError({ tool: address })
      }
      const tool = found.value
      const call = tool.call
      if (call.kind === "host") {
        if (Option.isNone(hostTools)) {
          return yield* new HostToolError({
            handler: call.handler,
            detail: `${tool.integration} is run by its host, and no executor for host tools is installed`
          })
        }
        const result = yield* hostTools.value.execute({
          address,
          integration: tool.integration,
          connection: tool.connection,
          tool: ToolName.make(tool.name),
          handler: call.handler,
          arguments: input,
          context
        })
        return { kind: "complete", result }
      }
      const integration = yield* requireIntegration(tool.integration)
      const connection = yield* requireConnection({
        owner: tool.owner,
        integration: tool.integration,
        name: tool.connection
      })
      const run = (credential: Option.Option<ResolvedCredential>) =>
        Effect.gen(function* (): Effect.fn.Return<ToolExecution, IntegrationFailure> {
          if (call.kind === "mcp") {
            const called = yield* mcp.callTool(
              yield* requireMcpServer(integration),
              mcpCredential(credential),
              call.tool,
              input,
              answer
            )
            if (called.kind === "input-required") return called
            const result = yield* normalizeToolResult(tool.name, called.result).pipe(
              Effect.mapError((failed) =>
                called.declined.length === 0
                  ? failed
                  : new InvocationError({
                      code: failed.code,
                      detail: `${failed.detail}. ${declinedInputNote(called.declined)}`,
                      ...whenPresent("status", failed.status)
                    })
              )
            )
            return { kind: "complete", result }
          }

          // The document may base a single operation somewhere other than the
          // integration, so what it declared for this one wins.
          const server = call.server ?? integration.baseUrl
          if (server === undefined) {
            return yield* new InvalidInputError({
              field: "integration",
              detail: `${integration.slug} records no server to call`
            })
          }
          const result = yield* invoker.call({
            integration: integration.name,
            call,
            tool: tool.name,
            server,
            input,
            credential
          })
          return { kind: "complete", result }
        })

      const first = yield* Effect.result(run(yield* resolveCredential(integration, connection)))
      if (first._tag === "Success") return first.success
      if (connection.provider !== "oauth" || !rejectsCredential(first.failure)) {
        return yield* first.failure
      }
      const second = yield* Effect.result(run(yield* resolveCredential(integration, connection, true)))
      if (second._tag === "Success") return second.success
      if (rejectsCredential(second.failure)) {
        yield* store.requireReconnect(
          { owner: connection.owner, integration: connection.integration, name: connection.name },
          "The provider rejected the connection's token even after a refresh"
        )
      }
      return yield* second.failure
    })

    return { toolSummaries, listTools, describeTool, execute }
  })
