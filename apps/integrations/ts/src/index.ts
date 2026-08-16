import { Schema } from "effect"

/** The client is deliberately dumb: authenticate, send, decode. Every decision
 * about whether a call may happen, which connection serves it, and whether a
 * human is asked lives behind the gateway.
 *
 * That is the point of the split — a sandbox holding this client holds no
 * authority beyond the grants attached to its key. */

export interface GatewayClientOptions {
  readonly url: string
  readonly apiKey: string
  /** Injected for tests, or to route through a proxy. */
  readonly fetch?: typeof globalThis.fetch
}

export class GatewayError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown, message: string) {
    super(message)
    this.name = "GatewayError"
    this.status = status
    this.body = body
  }
}

type Json = typeof Schema.Json.Type

const GrantedTool = Schema.Struct({
  alias: Schema.String,
  tool: Schema.String,
  integration: Schema.String,
  decision: Schema.Literals(["allow", "require_approval"]),
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json)
})
export type GrantedTool = typeof GrantedTool.Type

const GrantedTools = Schema.Struct({ tools: Schema.Array(GrantedTool) })

/** What a delegated call comes back as.
 *
 * `pending` is a first-class outcome rather than an error: the gateway froze
 * the call for a human, and the caller polls instead of blocking. Blocking
 * would hold a sandbox process open across a human's lunch break. */
export const InvocationOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("succeeded"), result: Schema.Json }),
  Schema.Struct({
    status: Schema.Literal("pending"),
    approvalId: Schema.String,
    expiresAt: Schema.String
  }),
  Schema.Struct({ status: Schema.Literal("denied"), reason: Schema.String }),
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String })
])
export type InvocationOutcome = typeof InvocationOutcome.Type

const ApprovalRecord = Schema.Struct({
  id: Schema.String,
  alias: Schema.String,
  tool: Schema.String,
  status: Schema.Literals(["pending", "approved", "denied", "expired"]),
  arguments: Schema.Json,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  decidedBy: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.Json),
  error: Schema.NullOr(Schema.String)
})
export type ApprovalRecord = typeof ApprovalRecord.Type

const decodeGrantedTools = Schema.decodeUnknownSync(GrantedTools)
const decodeOutcome = Schema.decodeUnknownSync(InvocationOutcome)
const decodeApproval = Schema.decodeUnknownSync(ApprovalRecord)

export interface GatewayClient {
  readonly url: string
  request(method: string, path: string, body?: unknown): Promise<unknown>

  /** The tools this key can reach. Grant-scoped, so an ungranted tool is
   *  absent rather than present-and-failing.
   *
   *  Schemas are opt-in because they cost a catalog read per grant. */
  tools(options?: { readonly schemas?: boolean }): Promise<ReadonlyArray<GrantedTool>>
  execute(input: {
    readonly alias: string
    readonly tool: string
    readonly arguments?: Json
  }): Promise<InvocationOutcome>
  approval(id: string): Promise<ApprovalRecord>
  health(): Promise<boolean>
}

export const createGatewayClient = (options: GatewayClientOptions): GatewayClient => {
  const doFetch = options.fetch ?? globalThis.fetch
  const base = options.url.replace(/\/+$/, "")

  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const text = await response.text()
    const parsed: unknown = text.trim().length === 0 ? {} : JSON.parse(text)
    if (!response.ok) {
      const message = typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `${method} ${path} failed with ${response.status}`
      throw new GatewayError(response.status, parsed, message)
    }
    return parsed
  }

  return {
    url: base,
    request,
    tools: async (options) =>
      decodeGrantedTools(
        await request("GET", options?.schemas === true ? "/v1/tools?schemas=true" : "/v1/tools")
      ).tools,
    execute: async (input) =>
      decodeOutcome(await request("POST", "/v1/execute", {
        alias: input.alias,
        tool: input.tool,
        arguments: input.arguments ?? {}
      })),
    approval: async (id) => decodeApproval(await request("GET", `/v1/approvals/${id}`)),
    health: async () => {
      try {
        await request("GET", "/v1/health")
        return true
      } catch {
        return false
      }
    }
  }
}

export {
  defaultGatewayPort,
  GatewayConfigFile,
  gatewayConfigPath,
  integrationsHome,
  readGatewayConfig,
  resolveClientConnection,
  writeGatewayConfig
} from "./config.ts"
export type { ClientConnection } from "./config.ts"

export {
  bindingName,
  generateEffectModule,
  generateModule,
  generateTypeScriptModule,
  typeName
} from "./codegen.ts"
export type { CodegenTarget, GeneratableTool } from "./codegen.ts"
