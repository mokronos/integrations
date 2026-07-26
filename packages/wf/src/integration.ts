import { Schema } from "effect"
import type { SecretResolutionContext, Step, StepRetryPolicy } from "./core.ts"

const AuthRefPrefix = "auth:"

export const AuthRef = Schema.declare<string>(
  (value): value is string => typeof value === "string" && value.startsWith(AuthRefPrefix)
).pipe(Schema.brand("AuthRef"))
export type AuthRef = typeof AuthRef.Type

export const auth = (name: string): AuthRef => AuthRef.make(`${AuthRefPrefix}${name}`)
const authName = (reference: AuthRef): string => reference.slice(AuthRefPrefix.length)

export const IntegrationAuth = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("bearer"), credential: AuthRef }),
  Schema.Struct({
    kind: Schema.Literal("api-key"),
    credential: AuthRef,
    header: Schema.optional(Schema.String)
  }),
  Schema.Struct({
    kind: Schema.Literal("header"),
    credential: AuthRef,
    header: Schema.String,
    prefix: Schema.optional(Schema.String)
  })
])
export type IntegrationAuth = typeof IntegrationAuth.Type

export const IntegrationParameterBinding = Schema.Struct({
  name: Schema.String,
  in: Schema.Literals(["path", "query", "header", "cookie"]),
  input: Schema.optional(Schema.String)
})
export type IntegrationParameterBinding = typeof IntegrationParameterBinding.Type

export const IntegrationSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("mcp"), url: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("openapi"),
    url: Schema.String,
    method: Schema.Literals(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]),
    path: Schema.optional(Schema.String),
    spec: Schema.optional(Schema.String),
    parameters: Schema.optional(Schema.Array(IntegrationParameterBinding)),
    body: Schema.optional(Schema.String),
    contentType: Schema.optional(Schema.Literal("application/json")),
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String))
  })
])
export type IntegrationSource = typeof IntegrationSource.Type

export class IntegrationError extends Schema.TaggedErrorClass<IntegrationError>()("IntegrationError", {
  message: Schema.String,
  operation: Schema.String,
  status: Schema.optional(Schema.Number)
}) {}

const IntegrationErrorSchema = IntegrationError
const Json = Schema.Json
type Json = typeof Json.Type
const JsonObject = Schema.Record(Schema.String, Json)
type JsonObject = typeof JsonObject.Type

const JsonRpcId = Schema.Union([Schema.String, Schema.Number])
const JsonRpcError = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Json)
})
const JsonRpcResponse = Schema.Union([
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: JsonRpcId,
    result: Json
  }),
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: JsonRpcId,
    error: JsonRpcError
  })
])
type JsonRpcResponse = typeof JsonRpcResponse.Type

const McpInitializeResult = Schema.Struct({
  protocolVersion: Schema.String,
  capabilities: Schema.optional(Json),
  serverInfo: Schema.optional(Json)
})

const McpCallResult = Schema.Struct({
  structuredContent: Schema.optional(Json),
  content: Schema.optional(Schema.Array(Json)),
  isError: Schema.optional(Schema.Boolean)
})

export const McpTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  inputSchema: Schema.optional(Json),
  outputSchema: Schema.optional(Json),
  annotations: Schema.optional(Json)
})
export type McpTool = typeof McpTool.Type

const McpToolsList = Schema.Struct({
  tools: Schema.Array(McpTool),
  nextCursor: Schema.optional(Schema.String)
})

export const McpServerDiscovery = Schema.Struct({
  url: Schema.String,
  protocolVersion: Schema.String,
  capabilities: Schema.optional(Json),
  serverInfo: Schema.optional(Json),
  tools: Schema.Array(McpTool)
})
export type McpServerDiscovery = typeof McpServerDiscovery.Type

export const resolveAuthorizationHeaders = async (
  reference: IntegrationAuth | undefined,
  resolveSecret: (name: string, context?: SecretResolutionContext) => string | Promise<string>,
  resource?: string
): Promise<Record<string, string>> => {
  if (reference === undefined) return {}
  const credential = await resolveSecret(
    authName(reference.credential),
    resource === undefined ? {} : { resource }
  )
  switch (reference.kind) {
    case "bearer":
      return { authorization: `Bearer ${credential}` }
    case "api-key":
      return { [reference.header ?? "x-api-key"]: credential }
    case "header":
      return { [reference.header]: `${reference.prefix ?? ""}${credential}` }
  }
}

const parameterText = (value: Json, operation: string, name: string): string => {
  if (value === null) return ""
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  throw new IntegrationError({
    message: `${operation} parameter ${name} must be a string, number, boolean, or null`,
    operation
  })
}

const appendQueryValue = (url: URL, name: string, value: Json, operation: string): void => {
  if (Array.isArray(value)) {
    for (const entry of value) url.searchParams.append(name, parameterText(entry, operation, name))
    return
  }
  url.searchParams.append(name, parameterText(value, operation, name))
}

const openApiRequest = (options: {
  readonly source: Extract<IntegrationSource, { readonly kind: "openapi" }>
  readonly operation: string
  readonly authHeaders: Record<string, string>
  readonly input: Json
}): { readonly url: URL; readonly headers: Record<string, string>; readonly body?: string } => {
  const bindings = options.source.parameters ?? []
  const needsObject = bindings.length > 0 || options.source.body !== undefined
  const inputObject = needsObject
    ? Schema.decodeUnknownSync(JsonObject)(options.input)
    : undefined
  let operationPath = options.source.path ?? ""
  const headers: Record<string, string> = {
    ...(options.source.headers ?? {}),
    ...options.authHeaders
  }
  const cookies: Array<string> = []
  const usedInputNames = new Set<string>()
  const pendingQuery: Array<readonly [string, Json]> = []

  for (const binding of bindings) {
    const inputName = binding.input ?? binding.name
    const value = inputObject?.[inputName]
    if (value === undefined) {
      throw new IntegrationError({
        message: `${options.operation} is missing input ${inputName} for ${binding.in} parameter ${binding.name}`,
        operation: options.operation
      })
    }
    usedInputNames.add(inputName)
    switch (binding.in) {
      case "path":
        operationPath = operationPath.replaceAll(
          `{${binding.name}}`,
          encodeURIComponent(parameterText(value, options.operation, binding.name))
        )
        break
      case "query":
        pendingQuery.push([binding.name, value])
        break
      case "header":
        headers[binding.name] = parameterText(value, options.operation, binding.name)
        break
      case "cookie":
        cookies.push(`${encodeURIComponent(binding.name)}=${encodeURIComponent(parameterText(value, options.operation, binding.name))}`)
        break
    }
  }

  if (/\{[^}]+\}/.test(operationPath)) {
    throw new IntegrationError({
      message: `${options.operation} has unresolved path parameters in ${operationPath}`,
      operation: options.operation
    })
  }
  const url = new URL(operationPath, options.source.url)
  for (const [name, value] of pendingQuery) appendQueryValue(url, name, value, options.operation)
  if (cookies.length > 0) {
    headers["cookie"] = [headers["cookie"], ...cookies].filter((value) => value !== undefined).join("; ")
  }

  if (options.source.method === "GET" || options.source.method === "HEAD") {
    return { url, headers }
  }
  let bodyValue: Json
  if (options.source.body !== undefined) {
    const selected = inputObject?.[options.source.body]
    if (selected === undefined) {
      throw new IntegrationError({
        message: `${options.operation} is missing request body input ${options.source.body}`,
        operation: options.operation
      })
    }
    bodyValue = selected
  } else if (inputObject !== undefined && bindings.length > 0) {
    bodyValue = Object.fromEntries(
      Object.entries(inputObject).filter(([name]) => !usedInputNames.has(name))
    )
  } else {
    bodyValue = options.input
  }
  headers["content-type"] = options.source.contentType ?? "application/json"
  return { url, headers, body: JSON.stringify(bodyValue) }
}

const executeOpenApi = async (options: {
  readonly source: Extract<IntegrationSource, { readonly kind: "openapi" }>
  readonly operation: string
  readonly headers: Record<string, string>
  readonly input: Json
}): Promise<Json | undefined> => {
  const request = openApiRequest({
    source: options.source,
    operation: options.operation,
    authHeaders: options.headers,
    input: options.input
  })
  const response = await fetch(request.url, {
    method: options.source.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body })
  })
  if (!response.ok) {
    throw new IntegrationError({
      message: `${options.operation} failed: ${response.status} ${response.statusText}`,
      operation: options.operation,
      status: response.status
    })
  }
  if (response.status === 204) return undefined
  const text = await response.text()
  if (text.length === 0) return undefined
  try {
    return Schema.decodeUnknownSync(Json)(JSON.parse(text))
  } catch {
    throw new IntegrationError({
      message: `${options.operation} returned a non-JSON response`,
      operation: options.operation,
      status: response.status
    })
  }
}

interface McpSession {
  readonly id?: string
  readonly protocolVersion: string
  readonly capabilities?: Json
  readonly serverInfo?: Json
}

const postMcpMessage = (options: {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: Json
  readonly session?: McpSession
}) => fetch(options.url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...options.headers,
    ...(options.session?.id === undefined ? {} : { "mcp-session-id": options.session.id }),
    ...(options.session === undefined ? {} : { "mcp-protocol-version": options.session.protocolVersion })
  },
  body: JSON.stringify(options.body)
})

const jsonRpcFromSse = (
  text: string,
  operation: string,
  expectedId: typeof JsonRpcId.Type
): JsonRpcResponse => {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (data.length === 0 || data === "[DONE]") continue
    try {
      const value = Schema.decodeUnknownSync(JsonRpcResponse)(JSON.parse(data))
      if (value.id === expectedId) return value
    } catch {
      // An SSE stream can contain notifications before the response we need.
    }
  }
  throw new IntegrationError({
    message: `${operation} SSE response did not contain a JSON-RPC response`,
    operation
  })
}

const readJsonRpcResponse = async (
  response: Response,
  operation: string,
  expectedId: typeof JsonRpcId.Type
): Promise<JsonRpcResponse> => {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (contentType.includes("text/event-stream")) {
    return jsonRpcFromSse(await response.text(), operation, expectedId)
  }
  try {
    const payload = await Schema.decodeUnknownPromise(JsonRpcResponse)(await response.json())
    if (payload.id !== expectedId) {
      throw new IntegrationError({
        message: `${operation} returned JSON-RPC id ${payload.id}, expected ${expectedId}`,
        operation,
        status: response.status
      })
    }
    return payload
  } catch {
    throw new IntegrationError({
      message: `${operation} returned an invalid JSON-RPC response`,
      operation,
      status: response.status
    })
  }
}

const initializeMcp = async (options: {
  readonly url: string
  readonly headers: Record<string, string>
  readonly operation: string
}): Promise<McpSession> => {
  const requestedProtocolVersion = "2025-06-18"
  const initializeResponse = await postMcpMessage({
    url: options.url,
    headers: options.headers,
    body: {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: requestedProtocolVersion,
        capabilities: {},
        clientInfo: { name: "@mokronos/wfkit", version: "0.2.0" }
      }
    }
  })
  if (!initializeResponse.ok) {
    throw new IntegrationError({
      message: `${options.operation} MCP initialization failed: ${initializeResponse.status} ${initializeResponse.statusText}`,
      operation: options.operation,
      status: initializeResponse.status
    })
  }
  const payload = await readJsonRpcResponse(initializeResponse, `${options.operation} initialize`, 0)
  if ("error" in payload) {
    throw new IntegrationError({
      message: payload.error.message,
      operation: options.operation
    })
  }
  const initialized = await Schema.decodeUnknownPromise(McpInitializeResult)(payload.result)
  const sessionId = initializeResponse.headers.get("mcp-session-id") ?? undefined
  const session: McpSession = {
    ...(sessionId === undefined ? {} : { id: sessionId }),
    protocolVersion: initialized.protocolVersion ?? requestedProtocolVersion,
    ...(initialized.capabilities === undefined ? {} : { capabilities: initialized.capabilities }),
    ...(initialized.serverInfo === undefined ? {} : { serverInfo: initialized.serverInfo })
  }
  const initializedResponse = await postMcpMessage({
    url: options.url,
    headers: options.headers,
    session,
    body: { jsonrpc: "2.0", method: "notifications/initialized" }
  })
  if (!initializedResponse.ok) {
    throw new IntegrationError({
      message: `${options.operation} MCP initialization notification failed: ${initializedResponse.status}`,
      operation: options.operation,
      status: initializedResponse.status
    })
  }
  return session
}

const closeMcp = async (url: string, headers: Record<string, string>, session: McpSession): Promise<void> => {
  if (session.id === undefined) return
  try {
    await fetch(url, {
      method: "DELETE",
      headers: {
        ...headers,
        "mcp-session-id": session.id,
        "mcp-protocol-version": session.protocolVersion
      }
    })
  } catch {
    // Session cleanup is best effort and must not hide a completed tool call.
  }
}

const listToolsInSession = async (options: {
  readonly url: string
  readonly headers: Record<string, string>
  readonly session: McpSession
}): Promise<ReadonlyArray<McpTool>> => {
  const tools: Array<McpTool> = []
  let cursor: string | undefined
  for (let page = 0; page < 100; page += 1) {
    const response = await postMcpMessage({
      url: options.url,
      headers: options.headers,
      session: options.session,
      body: {
        jsonrpc: "2.0",
        id: page + 1,
        method: "tools/list",
        ...(cursor === undefined ? {} : { params: { cursor } })
      }
    })
    if (!response.ok) {
      throw new IntegrationError({
        message: `tools/list failed: ${response.status} ${response.statusText}`,
        operation: "tools/list",
        status: response.status
      })
    }
    const payload = await readJsonRpcResponse(response, "tools/list", page + 1)
    if ("error" in payload) {
      throw new IntegrationError({
        message: payload.error.message,
        operation: "tools/list"
      })
    }
    const listed = await Schema.decodeUnknownPromise(McpToolsList)(payload.result)
    tools.push(...listed.tools)
    if (listed.nextCursor === undefined) return tools
    cursor = listed.nextCursor
  }
  throw new IntegrationError({
    message: "tools/list exceeded 100 pages",
    operation: "tools/list"
  })
}

export const discoverMcpServer = async (
  url: string,
  headers: Record<string, string> = {}
): Promise<McpServerDiscovery> => {
  const session = await initializeMcp({ url, headers, operation: "tools/list" })
  try {
    return {
      url,
      protocolVersion: session.protocolVersion,
      ...(session.capabilities === undefined ? {} : { capabilities: session.capabilities }),
      ...(session.serverInfo === undefined ? {} : { serverInfo: session.serverInfo }),
      tools: await listToolsInSession({ url, headers, session })
    }
  } finally {
    await closeMcp(url, headers, session)
  }
}

export const listMcpTools = async (
  url: string,
  headers: Record<string, string> = {}
): Promise<ReadonlyArray<McpTool>> => (await discoverMcpServer(url, headers)).tools

const executeMcp = async (options: {
  readonly source: Extract<IntegrationSource, { readonly kind: "mcp" }>
  readonly operation: string
  readonly headers: Record<string, string>
  readonly input: Json
}): Promise<Json> => {
  const session = await initializeMcp({
    url: options.source.url,
    headers: options.headers,
    operation: options.operation
  })
  try {
    const response = await postMcpMessage({
      url: options.source.url,
      headers: options.headers,
      session,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: options.operation, arguments: options.input }
      }
    })
    if (!response.ok) {
      throw new IntegrationError({
        message: `${options.operation} failed: ${response.status} ${response.statusText}`,
        operation: options.operation,
        status: response.status
      })
    }
    const payload = await readJsonRpcResponse(response, options.operation, 1)
    if ("error" in payload) {
      throw new IntegrationError({ message: payload.error.message, operation: options.operation })
    }
    const callResult = await Schema.decodeUnknownPromise(McpCallResult)(payload.result)
    if (callResult.isError === true) {
      throw new IntegrationError({
        message: `${options.operation} returned an MCP tool error`,
        operation: options.operation
      })
    }
    return callResult.structuredContent ?? payload.result
  } finally {
    await closeMcp(options.source.url, options.headers, session)
  }
}

export const integration = <I, O>(config: {
  readonly name?: string
  readonly source: IntegrationSource
  readonly operation: string
  readonly auth?: IntegrationAuth
  readonly input: Schema.Codec<I>
  readonly output: Schema.Codec<O>
  readonly retry?: StepRetryPolicy
}): Step<I, O, IntegrationError> => ({
  name: config.name ?? `Integration:${config.operation}`,
  input: config.input,
  output: config.output,
  errors: IntegrationErrorSchema,
  ...(config.retry === undefined ? {} : { retry: config.retry }),
  execute: async (input, step) => {
    const headers = await resolveAuthorizationHeaders(config.auth, step.resolveSecret, config.source.url)
    const jsonInput = Schema.decodeUnknownSync(Json)(input)
    const result = config.source.kind === "mcp"
      ? await executeMcp({ source: config.source, operation: config.operation, headers, input: jsonInput })
      : await executeOpenApi({ source: config.source, operation: config.operation, headers, input: jsonInput })
    return await Schema.decodeUnknownPromise(config.output)(result)
  }
})
