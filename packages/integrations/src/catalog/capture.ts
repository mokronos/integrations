import { Effect, Option, Schema } from "effect"
import {
  ConnectionName,
  IntegrationSlug,
  OwnerTier,
  ToolName,
  toolAddress,
  whenPresent
} from "@mokronos/contracts"
import { StorageError } from "../errors.ts"
import type { McpToolDefinition } from "../mcp/client.ts"
import { normalizeOutputSchema } from "../mcp/result.ts"
import type { CompiledSpec } from "../openapi/compile.ts"
import { Tool } from "@mokronos/core-integrations"
import type { Tool as IntegrationTool, ToolCall } from "@mokronos/core-integrations"

/** Converting an integration into tools.
 *
 *  This is the whole of the difference between protocols. An MCP server hands
 *  back tools already shaped like tools; an OpenAPI document hands back
 *  operations that have to be projected into the same shape. After this module
 *  runs, nothing downstream can tell which one it was — a tool is a name, a
 *  description, two schemas, a read-only flag, and a descriptor saying how to
 *  perform it.
 *
 *  Capture happens on connect and on refresh, not on read. An MCP server must be
 *  connected to before it will list anything, so doing this per read would make
 *  opening a dashboard one network round trip per connection. */

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

/** MCP tools, as the server describes them.
 *
 *  `readOnlyHint` is the server's own claim and the only thing that earns a tool
 *  an `allow` policy. A server that declares nothing gets `false`, which is the
 *  direction to fail in. */
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

/** OpenAPI operations, projected into the same shape.
 *
 *  Read-only here is a safe HTTP method, which is a stronger claim than any
 *  annotation because the protocol defines it rather than the vendor asserting
 *  it. */
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
