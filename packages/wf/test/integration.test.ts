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
import type { StepContext } from "../src/index.ts"

const servers: Array<ReturnType<typeof Bun.serve>> = []
const directories: Array<string> = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe("integration node", () => {
  test("local step context does not expose integration invocation", () => {
    type LocalStepCanInvokeIntegration = "invokeIntegration" extends keyof StepContext<never>
      ? true
      : false
    const canInvokeIntegration: LocalStepCanInvokeIntegration = false
    expect(canInvokeIntegration).toBe(false)
  })

  test("integration failures use the same transient retry policy in memory and sqlite", async () => {
    const unavailable = integration({
      source: { kind: "gateway", alias: "temporary", tool: "fail" },
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

  test("memory client receives its integration adapter from the runtime", async () => {
    const EchoOutput = t.struct({ echoed: t.string })
    const echo = integration({
      source: { kind: "gateway", alias: "echo", tool: "echo" },
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
})
