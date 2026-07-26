import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const cliPath = path.join(repoRoot, "packages", "wf-cli", "src", "main.ts")
const workflowPath = path.join(repoRoot, "examples", "connected-case", "workflow.ts")
const decoder = new TextDecoder()
const servers: Array<ReturnType<typeof Bun.serve>> = []
const directories: Array<string> = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

const McpRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(Schema.Json)
})
const ToolCall = Schema.Struct({ name: Schema.String, arguments: Schema.Json })
const ToolList = Schema.Struct({ cursor: Schema.optional(Schema.String) })
const ApprovalBody = Schema.Struct({ approvedBy: Schema.String, summary: Schema.String })
const RegistrationRequest = Schema.Struct({
  redirect_uris: Schema.Array(Schema.String),
  token_endpoint_auth_method: Schema.String,
  grant_types: Schema.Array(Schema.String),
  response_types: Schema.Array(Schema.String)
})

const sse = (payload: Schema.Schema.Type<typeof Schema.Json>): Response => new Response(
  `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
  { headers: { "content-type": "text/event-stream" } }
)

const openApiDocument = (baseUrl: string) => ({
  openapi: "3.1.0",
  info: { title: "Connected Case API", version: "1.0.0" },
  servers: [{ url: baseUrl }],
  paths: {
    "/customers/{customerId}": {
      get: {
        operationId: "getCustomer",
        summary: "Look up a customer",
        parameters: [
          { $ref: "#/components/parameters/CustomerId" },
          { name: "include", in: "query", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": {
            description: "Customer",
            content: { "application/json": { schema: { type: "object", required: ["id", "name", "tier"] } } }
          }
        }
      }
    },
    "/policies/{tier}": {
      get: {
        operationId: "getPolicy",
        parameters: [{ name: "tier", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Policy", content: { "application/json": { schema: { type: "object" } } } } }
      }
    },
    "/cases/{caseId}/approve": {
      post: {
        operationId: "approveCase",
        parameters: [{ name: "caseId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["approvedBy", "summary"] } } }
        },
        security: [{ oauth: ["cases:write"] }],
        responses: { "200": { description: "Audit", content: { "application/json": { schema: { type: "object" } } } } }
      }
    },
    "/uploads": {
      post: {
        operationId: "uploadAttachment",
        requestBody: {
          required: true,
          content: { "multipart/form-data": { schema: { type: "object" } } }
        },
        responses: { "204": { description: "Uploaded" } }
      }
    }
  },
  components: {
    parameters: {
      CustomerId: { name: "customerId", in: "path", required: true, schema: { type: "string" } }
    },
    securitySchemes: {
      oauth: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: `${baseUrl}/authorize`,
            tokenUrl: `${baseUrl}/token`,
            scopes: { "cases:read": "Read cases", "cases:write": "Write cases" }
          }
        }
      }
    }
  }
})

const fixture = () => {
  let registeredRedirect = ""
  let authorizationChallenge = ""
  let refreshGeneration = 0
  let customerRequests = 0
  let policyRequests = 0
  let createCaseCalls = 0
  let approvalCalls = 0
  let toolListPages = 0

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      const baseUrl = `http://127.0.0.1:${server.port}`
      if (url.pathname === "/api/search") {
        return Response.json({
          results: [{
            domain: "case.test",
            name: "Connected Case",
            description: "Case management with OpenAPI and MCP",
            kinds: ["mcp", "openapi"],
            url: `${baseUrl}/case.test`
          }]
        })
      }
      if (url.pathname === "/api/case.test/surface") {
        return Response.json({
          version: 3,
          domain: "case.test",
          summary: "Connected case fixture",
          credentials: {
            case_manager_oauth: {
              type: "oauth2",
              label: "Case manager OAuth",
              acquisition: "automatic",
              setup: "Authorize in the browser"
            }
          },
          surfaces: [
            {
              type: "mcp",
              url: `${baseUrl}/mcp`,
              name: "Case manager MCP",
              transports: ["streamable-http"],
              auth: {
                status: "required",
                entries: [{ use: [{ id: "case_manager_oauth", mechanics: { source: "well-known" } }] }]
              }
            },
            {
              type: "http",
              url: baseUrl,
              spec: `${baseUrl}/openapi.json`,
              name: "Connected Case API",
              auth: { status: "unknown" },
              requiredHeaders: [{
                name: "x-workflow-client",
                source: { kind: "static", value: "connected-case-v1" }
              }]
            }
          ]
        })
      }
      if (url.pathname === "/openapi.json") return Response.json(openApiDocument(baseUrl))

      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${baseUrl}/mcp`,
          authorization_servers: [baseUrl],
          scopes_supported: ["cases:read", "cases:write"],
          bearer_methods_supported: ["header"]
        })
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          registration_endpoint: `${baseUrl}/register`,
          scopes_supported: ["cases:read", "cases:write"],
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"]
        })
      }
      if (url.pathname === "/register") {
        const registration = await Schema.decodeUnknownPromise(RegistrationRequest)(await request.json())
        expect(registration.token_endpoint_auth_method).toBe("none")
        expect(registration.grant_types).toContain("refresh_token")
        registeredRedirect = registration.redirect_uris[0] ?? ""
        return Response.json({ client_id: "case-dynamic-client", token_endpoint_auth_method: "none" }, { status: 201 })
      }
      if (url.pathname === "/authorize") {
        expect(url.searchParams.get("client_id")).toBe("case-dynamic-client")
        expect(url.searchParams.get("redirect_uri")).toBe(registeredRedirect)
        expect(url.searchParams.get("scope")).toBe("cases:read cases:write")
        expect(url.searchParams.get("resource")).toBe(`${baseUrl}/mcp`)
        authorizationChallenge = url.searchParams.get("code_challenge") ?? ""
        const callback = new URL(registeredRedirect)
        callback.searchParams.set("code", "case-authorization-code")
        callback.searchParams.set("state", url.searchParams.get("state") ?? "")
        callback.searchParams.set("iss", baseUrl)
        return new Response(null, { status: 302, headers: { location: callback.toString() } })
      }
      if (url.pathname === "/token") {
        const body = new URLSearchParams(await request.text())
        expect(body.get("client_id")).toBe("case-dynamic-client")
        expect(body.get("resource")).toBe(`${baseUrl}/mcp`)
        if (body.get("grant_type") === "authorization_code") {
          expect(body.get("code")).toBe("case-authorization-code")
          expect(createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url")).toBe(authorizationChallenge)
          return Response.json({
            access_token: "case-access-token-0",
            refresh_token: "case-refresh-token-0",
            token_type: "Bearer",
            expires_in: 0,
            scope: "cases:read cases:write"
          })
        }
        expect(body.get("grant_type")).toBe("refresh_token")
        expect(body.get("refresh_token")).toBe(`case-refresh-token-${refreshGeneration}`)
        refreshGeneration += 1
        return Response.json({
          access_token: `case-access-token-${refreshGeneration}`,
          refresh_token: `case-refresh-token-${refreshGeneration}`,
          token_type: "Bearer",
          expires_in: refreshGeneration === 1 ? 0 : 3600,
          scope: "cases:read cases:write"
        })
      }

      if (url.pathname === "/mcp") {
        if (request.method === "DELETE") return new Response(null, { status: 204 })
        const authorization = request.headers.get("authorization")
        if (authorization === null) {
          return Response.json({ error: "invalid_token" }, {
            status: 401,
            headers: {
              "www-authenticate": `Bearer realm="case", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`
            }
          })
        }
        expect(["Bearer case-access-token-1", "Bearer case-access-token-2"]).toContain(authorization)
        const payload = await Schema.decodeUnknownPromise(McpRequest)(await request.json())
        if (payload.method === "initialize") {
          const response = sse({
            jsonrpc: "2.0",
            id: payload.id ?? 0,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "connected-case", version: "1.0.0" }
            }
          })
          response.headers.set("mcp-session-id", "case-session")
          return response
        }
        expect(request.headers.get("mcp-session-id")).toBe("case-session")
        expect(request.headers.get("mcp-protocol-version")).toBe("2025-06-18")
        if (payload.method === "notifications/initialized") return new Response(null, { status: 202 })
        if (payload.method === "tools/list") {
          toolListPages += 1
          const params = payload.params === undefined ? {} : await Schema.decodeUnknownPromise(ToolList)(payload.params)
          if (params.cursor === undefined) {
            return sse({
              jsonrpc: "2.0",
              id: payload.id ?? 1,
              result: {
                tools: [{
                  name: "create_case",
                  description: "Create a support case",
                  inputSchema: {
                    type: "object",
                    required: ["customerId", "title"],
                    properties: { customerId: { type: "string" }, title: { type: "string" } }
                  },
                  outputSchema: {
                    type: "object",
                    required: ["caseId", "title"],
                    properties: { caseId: { type: "string" }, title: { type: "string" } }
                  }
                }],
                nextCursor: "second-page"
              }
            })
          }
          expect(params.cursor).toBe("second-page")
          return Response.json({
            jsonrpc: "2.0",
            id: payload.id ?? 2,
            result: {
              tools: [{
                name: "lookup_case",
                description: "Look up a support case",
                inputSchema: { type: "object", required: ["caseId"], properties: { caseId: { type: "string" } } }
              }]
            }
          })
        }
        if (payload.method === "tools/call") {
          const call = await Schema.decodeUnknownPromise(ToolCall)(payload.params)
          expect(call.name).toBe("create_case")
          expect(call.arguments).toEqual({ customerId: "C-42", title: "Escalated onboarding" })
          createCaseCalls += 1
          return sse({
            jsonrpc: "2.0",
            id: payload.id ?? 1,
            result: {
              content: [{ type: "text", text: "Created CASE-1" }],
              structuredContent: { caseId: "CASE-1", title: "Escalated onboarding" }
            }
          })
        }
      }

      if (url.pathname === "/customers/C-42") {
        customerRequests += 1
        expect(request.headers.get("x-workflow-client")).toBe("connected-case-v1")
        expect(url.searchParams.get("include")).toBe("account")
        if (customerRequests === 1) return new Response("temporary", { status: 503 })
        return Response.json({ id: "C-42", name: "Ada Lovelace", tier: "gold" })
      }
      if (url.pathname === "/policies/gold") {
        policyRequests += 1
        return Response.json({ tier: "gold", requiresApproval: true })
      }
      if (url.pathname === "/cases/CASE-1/approve") {
        approvalCalls += 1
        expect(request.headers.get("authorization")).toBeNull()
        const body = await Schema.decodeUnknownPromise(ApprovalBody)(await request.json())
        expect(body.approvedBy).toBe("reviewer@example.com")
        expect(body.summary).toContain("CASE-1: Ada Lovelace")
        return Response.json({ auditId: "AUDIT-1", caseId: "CASE-1", approvedBy: body.approvedBy })
      }
      return new Response("not found", { status: 404 })
    }
  })
  servers.push(server)
  const baseUrl = `http://127.0.0.1:${server.port}`
  return {
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    counts: () => ({ refreshGeneration, customerRequests, policyRequests, createCaseCalls, approvalCalls, toolListPages })
  }
}

interface CliResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const cliEnvironment = (home: string, baseUrl: string): Record<string, string | undefined> => ({
  ...process.env,
  NO_COLOR: "1",
  WF_HOME: home,
  WF_INTEGRATIONS_BASE_URL: baseUrl,
  WF_CONNECTED_CASE_API_URL: baseUrl,
  WF_CONNECTED_CASE_MCP_URL: `${baseUrl}/mcp`
})

const runCli = async (
  args: ReadonlyArray<string>,
  environment: Record<string, string | undefined>
): Promise<CliResult> => {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, "run", cliPath, ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: environment
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text()
  ])
  return { exitCode, stdout, stderr }
}

const connectThroughBrowser = async (
  environment: Record<string, string | undefined>
): Promise<CliResult> => {
  const subprocess = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      cliPath,
      "integrations",
      "connect",
      "case.test",
      "--connection",
      "case_manager_oauth",
      "--scopes",
      "cases:read cases:write",
      "--no-open",
      "--timeout",
      "15"
    ],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: environment
  })
  let stdout = ""
  let browserCompleted = false
  const readOutput = async (): Promise<void> => {
    const reader = subprocess.stdout.getReader()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      stdout += decoder.decode(chunk.value, { stream: true })
      const authorizationUrl = /(http:\/\/127\.0\.0\.1:\d+\/authorize\?[^\s]+)/.exec(stdout)?.[1]
      if (authorizationUrl !== undefined && !browserCompleted) {
        browserCompleted = true
        const authorization = await fetch(authorizationUrl, { redirect: "manual" })
        const callback = authorization.headers.get("location")
        expect(callback).not.toBeNull()
        const callbackResponse = await fetch(callback ?? "")
        expect(callbackResponse.status).toBe(200)
        expect(await callbackResponse.text()).toContain("Account connected")
      }
    }
    stdout += decoder.decode()
  }
  const stderrPromise = new Response(subprocess.stderr).text()
  await readOutput()
  const [exitCode, stderr] = await Promise.all([subprocess.exited, stderrPromise])
  expect(browserCompleted).toBe(true)
  return { exitCode, stdout, stderr }
}

const RunRow = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  result_json: Schema.NullOr(Schema.String)
})
type RunRow = typeof RunRow.Type

describe("agent integration acceptance flow", () => {
  test("discovers, authorizes, creates, suspends, resumes, and runs a complex workflow", async () => {
    const service = fixture()
    const home = await mkdtemp(path.join(os.tmpdir(), "wf-agent-flow-"))
    directories.push(home)
    const environment = cliEnvironment(home, service.baseUrl)

    const search = await runCli(["integrations", "search", "case", "--kind", "mcp", "--json"], environment)
    expect(search.exitCode).toBe(0)
    expect(search.stdout).toContain("case.test")

    const show = await runCli(["integrations", "show", "case.test", "--json"], environment)
    expect(show.exitCode).toBe(0)
    expect(show.stdout).toContain("case_manager_oauth")
    expect(show.stdout).toContain("openapi.json")

    const inspectOpenApi = await runCli([
      "integrations", "inspect-openapi", "case.test", "--operation", "getCustomer", "--json"
    ], environment)
    expect(inspectOpenApi.exitCode).toBe(0)
    expect(inspectOpenApi.stdout).toContain('"operationId": "getCustomer"')
    expect(inspectOpenApi.stdout).toContain('"location": "path"')
    expect(inspectOpenApi.stdout).toContain('"reference": "#/components/parameters/CustomerId"')

    const unsupportedOpenApi = await runCli([
      "integrations", "inspect-openapi", "case.test", "--operation", "uploadAttachment"
    ], environment)
    expect(unsupportedOpenApi.exitCode).toBe(0)
    expect(unsupportedOpenApi.stdout).toContain("integration unavailable: unsupported request body media types: multipart/form-data")

    const connect = await connectThroughBrowser(environment)
    expect(connect.exitCode).toBe(0)
    expect(connect.stdout).toContain("Connected case_manager_oauth")
    expect(connect.stdout).not.toContain("case-access-token")

    const connections = await runCli(["integrations", "connections", "--json"], environment)
    expect(connections.exitCode).toBe(0)
    expect(connections.stdout).toContain('"id": "case_manager_oauth"')
    expect(connections.stdout).not.toContain("case-refresh-token")

    const inspectMcp = await runCli([
      "integrations", "inspect-mcp", "case.test", "--connection", "case_manager_oauth", "--json"
    ], environment)
    expect(inspectMcp.exitCode).toBe(0)
    expect(inspectMcp.stdout).toContain('"name": "create_case"')
    expect(inspectMcp.stdout).toContain('"name": "lookup_case"')

    const validate = await runCli([
      "integrations",
      "validate",
      JSON.stringify({
        domain: "case.test",
        source: {
          kind: "openapi",
          url: service.baseUrl,
          method: "GET",
          path: "/customers/{customerId}",
          spec: `${service.baseUrl}/openapi.json`,
          parameters: [
            { name: "customerId", in: "path" },
            { name: "include", in: "query" }
          ]
        },
        operation: "getCustomer"
      }),
      "--live",
      "--input",
      JSON.stringify({ customerId: "C-42", include: "account" }),
      "--json"
    ], environment)
    expect(validate.exitCode).toBe(0)
    expect(validate.stdout).toContain("operation getCustomer is available")

    const mismatchedServer = await runCli([
      "integrations",
      "validate",
      JSON.stringify({
        domain: "case.test",
        source: {
          kind: "openapi",
          url: `${service.baseUrl}/attacker`,
          method: "POST",
          path: "/cases/{caseId}/approve",
          spec: `${service.baseUrl}/openapi.json`,
          parameters: [{ name: "caseId", in: "path" }],
          body: "body",
          contentType: "application/json"
        },
        operation: "approveCase",
        auth: { kind: "bearer", credential: "auth:case_manager_oauth" }
      }),
      "--live",
      "--input",
      JSON.stringify({ caseId: "CASE-1", body: { approvedBy: "reviewer", summary: "test" } }),
      "--json"
    ], environment)
    expect(mismatchedServer.exitCode).not.toBe(0)
    expect(mismatchedServer.stdout).toContain(`declared for server ${service.baseUrl}, not ${service.baseUrl}/attacker`)

    const create = await runCli([
      "create", "connected-case", "--file", workflowPath, "--version", "1"
    ], environment)
    expect(create.exitCode).toBe(0)
    expect(create.stdout).toContain("Created connected-case")

    const run = await runCli([
      "run",
      "connected-case",
      JSON.stringify({ customerId: "C-42", customerTier: "gold", title: "Escalated onboarding" })
    ], environment)
    expect(run.exitCode).toBe(0)
    expect(`${run.stdout}\n${run.stderr}`).toContain("caseApproval")

    const catalog = new Database(path.join(home, "wf.sqlite"), { readonly: true })
    const rawRun = catalog.query<RunRow, []>(`
      SELECT id, status, result_json
      FROM workflow_runs
      ORDER BY started_at DESC
      LIMIT 1
    `).get()
    expect(rawRun).not.toBeNull()
    const suspended = Schema.decodeUnknownSync(RunRow)(rawRun)
    expect(suspended.status).toBe("running")

    const signal = await runCli([
      "signal",
      suspended.id,
      "caseApproval",
      JSON.stringify({ approved: true, reviewer: "reviewer@example.com" }),
      "--actor",
      "acceptance-test"
    ], environment)
    expect(signal.exitCode).toBe(0)
    expect(signal.stdout).toContain("AUDIT-1")

    const completed = Schema.decodeUnknownSync(RunRow)(catalog.query<RunRow, [string]>(`
      SELECT id, status, result_json
      FROM workflow_runs
      WHERE id = ?
    `).get(suspended.id))
    expect(completed.status).toBe("completed")
    const result = Schema.decodeUnknownSync(Schema.Struct({
      caseId: Schema.String,
      customerName: Schema.String,
      approvedBy: Schema.String,
      auditId: Schema.String,
      summary: Schema.String
    }))(JSON.parse(completed.result_json ?? "null"))
    expect(result).toEqual({
      caseId: "CASE-1",
      customerName: "Ada Lovelace",
      approvedBy: "reviewer@example.com",
      auditId: "AUDIT-1",
      summary: result.summary
    })
    expect(result.summary).toContain("approval=true")
    const storedWorkflow = Schema.decodeUnknownSync(Schema.Struct({ source: Schema.String }))(
      catalog.query<{ readonly source: string }, []>("SELECT source FROM workflows WHERE id = 'connected-case'").get()
    )
    expect(storedWorkflow.source).toContain('auth("case_manager_oauth")')
    catalog.close()

    expect(service.counts()).toEqual({
      refreshGeneration: 2,
      customerRequests: 2,
      policyRequests: 1,
      createCaseCalls: 1,
      approvalCalls: 1,
      toolListPages: 2
    })

    const files = await readdir(home)
    const persisted = Buffer.concat(await Promise.all(files.map((file) => readFile(path.join(home, file)))))
      .toString("utf8")
    for (const secret of [
      "case-authorization-code",
      "case-access-token-0",
      "case-access-token-1",
      "case-access-token-2",
      "case-refresh-token-0",
      "case-refresh-token-1",
      "case-refresh-token-2"
    ]) {
      expect(persisted).not.toContain(secret)
    }
  }, 45_000)
})
