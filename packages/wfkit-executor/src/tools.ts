import { ConnectionName, IntegrationSlug, ToolAddress } from "@executor-js/sdk/core"
import { Option, Schema } from "effect"
import { runExecutor } from "./default-host.ts"
import type { ExecutorRunner } from "./host.ts"
import {
  ExecutorToolAddress,
  type ExecutorTool
} from "./schemas.ts"

const ExecutorToolResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), data: Schema.Json }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      status: Schema.optional(Schema.Number)
    })
  })
])

const McpToolEnvelope = Schema.Struct({
  structuredContent: Schema.optional(Schema.Json),
  content: Schema.optional(Schema.Array(Schema.Json)),
  isError: Schema.optional(Schema.Boolean)
})

const McpTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
})

const McpEnvelopeOutputSchema = Schema.Struct({
  type: Schema.optional(Schema.Literal("object")),
  properties: Schema.Struct({
    content: Schema.Json,
    structuredContent: Schema.optional(Schema.Json),
    isError: Schema.Struct({ const: Schema.Literal(false) })
  })
})

type Json = typeof Schema.Json.Type

const compactMcpOutputSchema: Json = {}

const isMcpEnvelopeOutputSchema = (schema: Json): boolean =>
  Option.isSome(Schema.decodeUnknownOption(McpEnvelopeOutputSchema)(schema))

export const normalizeExecutorToolOutputSchema = (schema: Json): Json =>
  isMcpEnvelopeOutputSchema(schema) ? compactMcpOutputSchema : schema

const mcpText = (content: ReadonlyArray<Json>): string | undefined => {
  const first = content[0]
  if (content.length !== 1 || first === undefined) return undefined
  return Option.getOrUndefined(Schema.decodeUnknownOption(McpTextContent)(first))?.text
}

export const normalizeExecutorToolResult = (data: Json): Json => {
  const envelope = Option.getOrUndefined(Schema.decodeUnknownOption(McpToolEnvelope)(data))
  if (envelope === undefined) return data

  const content = envelope.content ?? []
  const text = mcpText(content)
  if (envelope.isError === true) {
    throw new Error(text ?? "MCP tool returned an error")
  }
  if (envelope.structuredContent !== undefined) return envelope.structuredContent
  if (text !== undefined) {
    return Option.getOrElse(
      Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text),
      () => text
    )
  }
  return content.length > 0 ? content : data
}

const optionalJson = <A>(value: A | undefined) =>
  value === undefined
    ? undefined
    : Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Json)(value))

export interface ExecutorTools {
  readonly list: (filter?: {
    readonly integration?: string
    readonly connection?: string
  }) => Promise<ReadonlyArray<ExecutorTool>>
  readonly execute: (address: ExecutorToolAddress, input: Json) => Promise<Json>
}

/** Tool operations bound to an explicit host/runner. */
export const createExecutorTools = (runner: ExecutorRunner): ExecutorTools => ({
  list: async (filter: {
    readonly integration?: string
    readonly connection?: string
  } = {}) => {
    const tools = await runner.run((executor) => executor.tools.list({
      ...(filter.integration === undefined ? {} : { integration: IntegrationSlug.make(filter.integration) }),
      ...(filter.connection === undefined ? {} : { connection: ConnectionName.make(filter.connection) })
    }))
    const callableTools = tools.filter((tool) => String(tool.address).startsWith("tools."))
    return await Promise.all(callableTools.map(async (tool) => {
      const schema = await runner.run((executor) => executor.tools.schema(tool.address))
      const inputSchema = optionalJson(schema?.inputSchema)
      const outputSchema = optionalJson(schema?.outputSchema)
      const normalizedOutputSchema = outputSchema === undefined
        ? undefined
        : normalizeExecutorToolOutputSchema(outputSchema)
      const hasMcpEnvelopeOutput = normalizedOutputSchema === compactMcpOutputSchema
      return {
        address: ExecutorToolAddress.make(String(tool.address)),
        name: String(tool.name),
        description: tool.description,
        integration: String(tool.integration),
        connection: String(tool.connection),
        ...(inputSchema === undefined ? {} : { inputSchema }),
        ...(normalizedOutputSchema === undefined ? {} : { outputSchema: normalizedOutputSchema }),
        ...(schema?.inputTypeScript === undefined ? {} : { inputTypeScript: schema.inputTypeScript }),
        ...(hasMcpEnvelopeOutput
          ? { outputTypeScript: "Json" }
          : schema?.outputTypeScript === undefined
            ? {}
            : { outputTypeScript: schema.outputTypeScript })
      }
    }))
  },
  execute: async (address, input) => {
    const result = await runner.run((executor) => executor.execute(ToolAddress.make(address), input))
    const decoded = await Schema.decodeUnknownPromise(ExecutorToolResult)(result)
    if (!decoded.ok) {
      throw new Error(`${decoded.error.code}: ${decoded.error.message}`)
    }
    return normalizeExecutorToolResult(decoded.data)
  }
})

const defaultTools = createExecutorTools({ run: runExecutor })

/** Lists callable tools exposed by installed integrations and their active
 * connections. */
export const listExecutorTools = defaultTools.list

export const executeExecutorTool = defaultTools.execute
