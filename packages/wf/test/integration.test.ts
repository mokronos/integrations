import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import {
  createWorkflowClient,
  createWorkflowRuntime,
  defineWorkflow,
  integration,
  StepExecutionError,
  t
} from "../src/index.ts"
import {
  createExecutorHost,
  createExecutorServices
} from "@mokronos/wfkit-executor"
import type { StepContext } from "../src/index.ts"

const servers: Array<ReturnType<typeof Bun.serve>> = []
const directories: Array<string> = []
const executorHosts: Array<ReturnType<typeof createExecutorHost>> = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  await Promise.all(executorHosts.splice(0).map((host) => host.close()))
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe("Executor integration node", () => {
  test("local step context does not expose integration invocation", () => {
    type LocalStepCanInvokeIntegration = "invokeIntegration" extends keyof StepContext<never>
      ? true
      : false
    const canInvokeIntegration: LocalStepCanInvokeIntegration = false
    expect(canInvokeIntegration).toBe(false)
  })

  test("integration failures use the same transient retry policy in memory and sqlite", async () => {
    const unavailable = integration({
      source: { kind: "executor", integration: "temporary", tool: "fail" },
      input: t.struct({}),
      output: t.struct({}),
      retry: { attempts: 3, backoff: "none" }
    })
    const workflow = defineWorkflow({
      name: "IntegrationRetryParity",
      input: t.struct({}),
      output: t.struct({}),
      run: function* (_, ctx) {
        return yield* ctx.run(unavailable, {})
      }
    })

    let memoryAttempts = 0
    const memoryError = await workflow.executeInMemory({}, {
      integrations: {
        invoke: async () => {
          memoryAttempts++
          throw new Error("temporarily unavailable")
        }
      }
    }).catch((error) => error)
    expect(memoryAttempts).toBe(3)
    expect(memoryError).toBeInstanceOf(StepExecutionError)

    let sqliteAttempts = 0
    const directory = await mkdtemp(path.join(os.tmpdir(), "wf-integration-retry-"))
    directories.push(directory)
    const runtime = createWorkflowRuntime({
      backend: "sqlite",
      databasePath: path.join(directory, "wf.sqlite"),
      integrations: {
        invoke: async () => {
          sqliteAttempts++
          throw new Error("temporarily unavailable")
        }
      }
    })
    const client = createWorkflowClient(runtime)
    try {
      const handle = await client.start(workflow, {})
      await expect(client.result(handle.executionId)).resolves.toMatchObject({
        type: "failed",
        error: { _tag: "StepExecutionError" }
      })
      expect(sqliteAttempts).toBe(3)
    } finally {
      await client.dispose()
    }
  })

  test("loads and invokes legacy address-based integration source", async () => {
    const legacyAddress = "tools.legacy.org.default.echo"
    const legacy = integration({
      source: { kind: "executor", address: legacyAddress },
      input: t.struct({ value: t.string }),
      output: t.struct({ echoed: t.string })
    })
    const workflow = defineWorkflow({
      name: "LegacyIntegrationSnapshot",
      input: t.struct({ value: t.string }),
      output: t.struct({ echoed: t.string }),
      run: function* (input, ctx) {
        return yield* ctx.run(legacy, input)
      }
    })

    expect(legacy.name).toBe(`Integration:${legacyAddress}`)
    await expect(workflow.executeInMemory({ value: "old" }, {
      integrations: {
        invoke: async (source, input) => {
          expect(source).toEqual({ kind: "executor", address: legacyAddress })
          return { echoed: JSON.stringify(input) }
        }
      }
    })).resolves.toEqual({ echoed: '{"value":"old"}' })
  })

  test("memory client receives its integration adapter from the runtime", async () => {
    const EchoOutput = t.struct({ echoed: t.string })
    const echo = integration({
      source: { kind: "executor", integration: "echo", tool: "echo" },
      input: t.struct({ value: t.string }),
      output: EchoOutput
    })
    const workflow = defineWorkflow({
      name: "MemoryIntegrationAdapterTest",
      input: t.struct({ value: t.string }),
      output: EchoOutput,
      run: function* (input, ctx) {
        return yield* ctx.run(echo, input)
      }
    })
    const runtime = createWorkflowRuntime({
      backend: "memory",
      integrations: {
        invoke: async (_source, input) => ({ echoed: JSON.stringify(input) })
      }
    })
    const client = createWorkflowClient(runtime)
    try {
      const handle = await client.start(workflow, { value: "hello" })
      await expect(client.result(handle.executionId)).resolves.toEqual({
        type: "completed",
        value: { echoed: '{"value":"hello"}' }
      })
    } finally {
      await client.dispose()
    }
  })

  test("invokes an authenticated OpenAPI tool through its persisted address", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wf-executor-integration-"))
    directories.push(directory)
    const host = createExecutorHost(directory)
    executorHosts.push(host)
    const executor = createExecutorServices(host)

    const server = Bun.serve({
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url)
        if (url.pathname === "/openapi.json") {
          return Response.json({
            openapi: "3.1.0",
            info: { title: "Issues", version: "1.0.0" },
            servers: [{ url: `http://127.0.0.1:${server.port}` }],
            paths: {
              "/issues": {
                post: {
                  operationId: "issues.create",
                  security: [{ apiKey: [] }],
                  requestBody: {
                    required: true,
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          required: ["title"],
                          properties: { title: { type: "string" } }
                        }
                      }
                    }
                  },
                  responses: {
                    "200": {
                      description: "Created",
                      content: {
                        "application/json": {
                          schema: {
                            type: "object",
                            required: ["id", "title"],
                            properties: {
                              id: { type: "string" },
                              title: { type: "string" }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            components: {
              securitySchemes: {
                apiKey: { type: "apiKey", in: "header", name: "x-api-key" }
              }
            }
          })
        }
        if (url.pathname !== "/issues") return new Response("not found", { status: 404 })
        expect(request.headers.get("x-api-key")).toBe("api-secret")
        expect(await request.json()).toEqual({ title: "A durable issue" })
        return Response.json({ id: "ISS-1", title: "A durable issue" })
      }
    })
    servers.push(server)

    await executor.catalog.addOpenApi({
      spec: `http://127.0.0.1:${server.port}/openapi.json`,
      slug: "issues"
    })
    const issues = await executor.catalog.find("issues")
    const authMethod = issues?.authMethods.find((method) => method.kind === "apikey")
    if (authMethod === undefined) throw new Error("Executor did not derive OpenAPI API-key auth")
    await executor.connections.create({
      integration: "issues",
      name: "default",
      template: authMethod.template,
      value: "api-secret"
    })
    const tool = (await executor.tools.list({ integration: "issues" })).find(
      (entry) => entry.name === "issues.create"
    )
    expect(tool).toBeDefined()
    expect(tool?.inputSchema).toBeDefined()
    expect(tool?.outputSchema).toBeDefined()

    const CreateIssueOutput = t.struct({ id: t.string, title: t.string })
    // Names the tool, not the connection: the step never sees the `org.default`
    // segments the address carries. `issues.create` also proves a dotted tool
    // name survives resolution.
    const createIssue = integration({
      source: { kind: "executor", integration: "issues", tool: "issues.create" },
      input: t.struct({ body: t.struct({ title: t.string }) }),
      output: CreateIssueOutput
    })
    const workflow = defineWorkflow({
      name: "ExecutorIntegrationTest",
      input: t.struct({ title: t.string }),
      output: CreateIssueOutput,
      run: function* (input, ctx) {
        return yield* ctx.run(createIssue, { body: input })
      }
    })

    await expect(workflow.executeInMemory(
      { title: "A durable issue" },
      { integrations: executor.integrationInvoker }
    )).resolves.toEqual({
      id: "ISS-1",
      title: "A durable issue"
    })
  })
})
