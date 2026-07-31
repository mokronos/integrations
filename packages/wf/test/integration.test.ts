import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import {
  defineWorkflow,
  integration,
  t
} from "../src/index.ts"
import {
  addExecutorOpenApi,
  closeExecutor,
  createExecutorConnection,
  listExecutorIntegrations,
  listExecutorTools,
  setExecutorStorageDirectory
} from "@mokronos/wfkit-executor"

const servers: Array<ReturnType<typeof Bun.serve>> = []
const directories: Array<string> = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const directory of directories.splice(0)) {
    await closeExecutor(directory)
    await rm(directory, { recursive: true, force: true })
  }
})

describe("Executor integration node", () => {
  test("invokes an authenticated OpenAPI tool through its persisted address", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wf-executor-integration-"))
    directories.push(directory)
    setExecutorStorageDirectory(directory)

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

    await addExecutorOpenApi({
      spec: `http://127.0.0.1:${server.port}/openapi.json`,
      slug: "issues"
    })
    const issues = (await listExecutorIntegrations()).find((entry) => entry.slug === "issues")
    const authMethod = issues?.authMethods.find((method) => method.kind === "apikey")
    if (authMethod === undefined) throw new Error("Executor did not derive OpenAPI API-key auth")
    await createExecutorConnection({
      integration: "issues",
      name: "default",
      template: authMethod.template,
      value: "api-secret"
    })
    const tool = (await listExecutorTools({ integration: "issues" })).find(
      (entry) => entry.name === "issues.create"
    )
    expect(tool).toBeDefined()
    expect(tool?.inputSchema).toBeDefined()
    expect(tool?.outputSchema).toBeDefined()

    const CreateIssueOutput = t.struct({ id: t.string, title: t.string })
    const createIssue = integration({
      source: { kind: "executor", address: tool?.address ?? "" },
      input: t.struct({ body: t.struct({ title: t.string }) }),
      output: CreateIssueOutput
    })
    const workflow = defineWorkflow({
      name: "ExecutorIntegrationTest",
      version: 1,
      input: t.struct({ title: t.string }),
      output: CreateIssueOutput,
      run: function* (input, ctx) {
        return yield* ctx.run(createIssue, { body: input })
      }
    })

    await expect(workflow.executeInMemory({ title: "A durable issue" })).resolves.toEqual({
      id: "ISS-1",
      title: "A durable issue"
    })
  })
})
