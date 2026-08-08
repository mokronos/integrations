import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
  ToolAddress
} from "@executor-js/sdk/core"
import { Effect, Option, Schema } from "effect"
import { getExecutor, runExecutor } from "./host.ts"
export {
  closeExecutor,
  executorStorageDirectory,
  getExecutor,
  setExecutorStorageDirectory
} from "./host.ts"
export {
  addExecutorMcp,
  addExecutorOpenApi,
  detectExecutorIntegration,
  findExecutorIntegration,
  listExecutorIntegrations,
  previewExecutorOpenApi,
  probeExecutorMcp
} from "./catalog.ts"
import {
  ExecutorToolAddress,
  type ExecutorConnection,
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
    isError: Schema.Struct({
      const: Schema.Literal(false)
    })
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

export const createExecutorConnection = async (options: {
  readonly integration: string
  readonly name: string
  readonly template: string
  readonly value: string
}): Promise<ExecutorConnection> =>
  await runExecutor((executor) => executor.connections.create({
    owner: "org",
    integration: IntegrationSlug.make(options.integration),
    name: ConnectionName.make(options.name),
    template: AuthTemplateSlug.make(options.template),
    value: options.value
  })).then((connection) => ({
    owner: connection.owner,
    name: String(connection.name),
    integration: String(connection.integration),
    template: String(connection.template),
    address: String(connection.address),
    ...(connection.identityLabel === undefined ? {} : { identityLabel: connection.identityLabel }),
    ...(connection.expiresAt === undefined ? {} : { expiresAt: connection.expiresAt })
  }))

export const listExecutorConnections = async (): Promise<ReadonlyArray<ExecutorConnection>> =>
  await runExecutor((executor) => executor.connections.list()).then((connections) =>
    connections.map((connection) => ({
      owner: connection.owner,
      name: String(connection.name),
      integration: String(connection.integration),
      template: String(connection.template),
      address: String(connection.address),
      ...(connection.identityLabel === undefined ? {} : { identityLabel: connection.identityLabel }),
      ...(connection.expiresAt === undefined ? {} : { expiresAt: connection.expiresAt })
    }))
  )

export const removeExecutorConnection = async (options: {
  readonly integration: string
  readonly name: string
}): Promise<void> =>
  await runExecutor((executor) => executor.connections.remove({
    owner: "org",
    integration: IntegrationSlug.make(options.integration),
    name: ConnectionName.make(options.name)
  }))

export const listExecutorTools = async (filter: {
  readonly integration?: string
  readonly connection?: string
} = {}): Promise<ReadonlyArray<ExecutorTool>> => {
  const executor = await getExecutor()
  const tools = await Effect.runPromise(executor.tools.list({
    ...(filter.integration === undefined ? {} : { integration: IntegrationSlug.make(filter.integration) }),
    ...(filter.connection === undefined ? {} : { connection: ConnectionName.make(filter.connection) })
  }))
  const callableTools = tools.filter((tool) => String(tool.address).startsWith("tools."))
  return await Promise.all(callableTools.map(async (tool) => {
    const schema = await Effect.runPromise(executor.tools.schema(tool.address))
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
}

export const executeExecutorTool = async (
  address: ExecutorToolAddress,
  input: Schema.Schema.Type<typeof Schema.Json>
): Promise<Schema.Schema.Type<typeof Schema.Json>> => {
  const result = await runExecutor((executor) => executor.execute(ToolAddress.make(address), input))
  const decoded = await Schema.decodeUnknownPromise(ExecutorToolResult)(result)
  if (!decoded.ok) {
    throw new Error(`${decoded.error.code}: ${decoded.error.message}`)
  }
  return normalizeExecutorToolResult(decoded.data)
}

export const probeExecutorOAuth = async (url: string) =>
  await runExecutor((executor) => executor.oauth.probe({ url }))

export const registerExecutorOAuthClient = async (options: {
  readonly slug: string
  readonly integration: string
  readonly redirectUri: string
  readonly issuer?: string | null
  readonly registrationEndpoint: string
  readonly authorizationUrl: string
  readonly tokenUrl: string
  readonly resource?: string | null
  readonly scopes: ReadonlyArray<string>
  readonly tokenEndpointAuthMethodsSupported?: ReadonlyArray<string>
}): Promise<string> =>
  await runExecutor((executor) => executor.oauth.registerDynamicClient({
    owner: "org",
    slug: OAuthClientSlug.make(options.slug),
    originIntegration: IntegrationSlug.make(options.integration),
    redirectUri: options.redirectUri,
    registrationEndpoint: options.registrationEndpoint,
    authorizationUrl: options.authorizationUrl,
    tokenUrl: options.tokenUrl,
    scopes: options.scopes,
    ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
    ...(options.resource === undefined ? {} : { resource: options.resource }),
    ...(options.tokenEndpointAuthMethodsSupported === undefined
      ? {}
      : { tokenEndpointAuthMethodsSupported: options.tokenEndpointAuthMethodsSupported })
  })).then(String)

export const createExecutorOAuthClient = async (options: {
  readonly slug: string
  readonly integration: string
  readonly authorizationUrl: string
  readonly tokenUrl: string
  readonly clientId: string
  readonly clientSecret?: string
  readonly resource?: string | null
}): Promise<string> =>
  await runExecutor((executor) => executor.oauth.createClient({
    owner: "org",
    slug: OAuthClientSlug.make(options.slug),
    origin: {
      kind: "manual",
      integration: IntegrationSlug.make(options.integration)
    },
    grant: "authorization_code",
    authorizationUrl: options.authorizationUrl,
    tokenUrl: options.tokenUrl,
    clientId: options.clientId,
    clientSecret: options.clientSecret ?? "",
    ...(options.resource === undefined ? {} : { resource: options.resource })
  })).then(String)

export const startExecutorOAuth = async (options: {
  readonly client: string
  readonly integration: string
  readonly connection: string
  readonly template: string
  readonly redirectUri: string
}) =>
  await runExecutor((executor) => executor.oauth.start({
    owner: "org",
    clientOwner: "org",
    client: OAuthClientSlug.make(options.client),
    integration: IntegrationSlug.make(options.integration),
    name: ConnectionName.make(options.connection),
    template: AuthTemplateSlug.make(options.template),
    redirectUri: options.redirectUri
  }))

export const completeExecutorOAuth = async (options: {
  readonly state: string
  readonly code: string
  readonly callbackDomain?: string | null
}): Promise<ExecutorConnection> =>
  await runExecutor((executor) => executor.oauth.complete({
    state: OAuthState.make(options.state),
    code: options.code,
    ...(options.callbackDomain === undefined ? {} : { callbackDomain: options.callbackDomain })
  })).then((connection) => ({
    owner: connection.owner,
    name: String(connection.name),
    integration: String(connection.integration),
    template: String(connection.template),
    address: String(connection.address),
    ...(connection.identityLabel === undefined ? {} : { identityLabel: connection.identityLabel }),
    ...(connection.expiresAt === undefined ? {} : { expiresAt: connection.expiresAt })
  }))
