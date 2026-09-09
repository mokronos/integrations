import { Effect, Option, Schema } from "effect"
import {
  ConnectionName,
  IntegrationSlug,
  OwnerTier,
  ToolName,
  toolAddress,
  whenPresent
} from "@integrations/contracts"
import { StorageError } from "../errors.ts"
import type { McpToolDefinition } from "../mcp/client.ts"
import { normalizeOutputSchema } from "../mcp/result.ts"
import type { CompiledSpec } from "../openapi/compile.ts"
import { Tool } from "../tool.ts"
import type { Tool as IntegrationTool, ToolCall } from "../tool.ts"

export interface CaptureTarget {
  readonly owner: OwnerTier
  readonly integration: IntegrationSlug
  readonly connection: ConnectionName
}

const record = (
  target: CaptureTarget,
  capturedAt: number,
  tool: {
    readonly name: string
    readonly description: string
    readonly readOnly: boolean
    readonly inputSchema?: typeof Schema.Json.Type
    readonly outputSchema?: typeof Schema.Json.Type
    readonly call: ToolCall
  }
): Effect.Effect<IntegrationTool, StorageError> =>
  Schema.decodeUnknownEffect(Tool)({
    address: toolAddress({
      integration: target.integration,
      owner: target.owner,
      connection: target.connection,
      tool: ToolName.make(tool.name)
    }),
    owner: target.owner,
    integration: target.integration,
    connection: target.connection,
    name: tool.name,
    description: tool.description,
    readOnly: tool.readOnly,
    ...whenPresent("inputSchema", tool.inputSchema),
    ...whenPresent("outputSchema", tool.outputSchema),
    call: tool.call,
    capturedAt
  }).pipe(Effect.mapError((cause) =>
    new StorageError({ message: `Could not capture tool ${tool.name}`, cause })
  ))

export const captureMcpTools = (
  target: CaptureTarget,
  definitions: ReadonlyArray<McpToolDefinition>,
  capturedAt: number
): Effect.Effect<ReadonlyArray<IntegrationTool>, StorageError> =>
  Effect.forEach(definitions, (definition) =>
    record(target, capturedAt, {
      name: definition.name,
      description: definition.description ?? definition.title ?? "",
      readOnly: definition.annotations?.readOnlyHint === true,
      ...whenPresent("inputSchema", definition.inputSchema),
      ...whenPresent(
        "outputSchema",
        definition.outputSchema === undefined
          ? undefined
          : normalizeOutputSchema(definition.outputSchema)
      ),
      call: { kind: "mcp", tool: definition.name }
    }))

export const captureOpenApiTools = (
  target: CaptureTarget,
  spec: CompiledSpec,
  capturedAt: number
): Effect.Effect<ReadonlyArray<IntegrationTool>, StorageError> =>
  Effect.forEach(spec.operations, (operation) =>
    record(target, capturedAt, {
      name: operation.name,
      description: Option.getOrElse(
        operation.summary,
        () => Option.getOrElse(operation.description, () => "")
      ),
      readOnly: operation.readOnly,
      inputSchema: operation.inputSchema,
      ...whenPresent("outputSchema", Option.getOrUndefined(operation.outputSchema)),
      call: {
        kind: "http",
        method: operation.method,
        path: operation.path,
        parameters: operation.parameters,
        locations: operation.locations,
        ...whenPresent("contentType", Option.getOrUndefined(operation.contentType)),
        ...whenPresent("bodyProperty", Option.getOrUndefined(operation.bodyProperty))
      }
    }))
