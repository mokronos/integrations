import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createExecutorHost } from "../src/host.ts"
import { createExecutorServices } from "../src/services.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })))
})

describe("executor services", () => {
  test("bind all capabilities to one explicitly owned host", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wf-executor-services-"))
    directories.push(directory)
    const host = createExecutorHost(directory)
    const services = createExecutorServices(host)

    expect(await services.catalog.list()).toEqual([])
    expect(services.auth.start).toBeFunction()
    expect(services.connections.create).toBeFunction()
    expect(services.discovery.inspect).toBeFunction()
    expect(services.provisioning.install).toBeFunction()
    expect(services.validateIntegrationNode).toBeFunction()
    // No invoker here any more: turning a workflow's alias into a call is the
    // gateway's job, because only it holds the grant that resolves the alias.
    expect(services).not.toHaveProperty("integrationInvoker")

    await expect(Promise.all([host.close(), host.close()])).resolves.toEqual([
      undefined,
      undefined
    ])
    await expect(host.executor()).rejects.toMatchObject({
      _tag: "ExecutorHostClosedError",
      directory
    })
  })

  test("keeps concurrently active hosts isolated", async () => {
    const firstDirectory = await mkdtemp(path.join(tmpdir(), "wf-executor-first-"))
    const secondDirectory = await mkdtemp(path.join(tmpdir(), "wf-executor-second-"))
    directories.push(firstDirectory, secondDirectory)
    const firstHost = createExecutorHost(firstDirectory)
    const secondHost = createExecutorHost(secondDirectory)
    const first = createExecutorServices(firstHost)
    const second = createExecutorServices(secondHost)
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({
        openapi: "3.1.0",
        info: { title: "First", version: "1" },
        paths: {}
      })
    })

    try {
      expect(await Promise.all([first.catalog.list(), second.catalog.list()])).toEqual([[], []])
      await first.catalog.addOpenApi({
        slug: "first",
        spec: `http://127.0.0.1:${server.port}/openapi.json`
      })

      expect((await first.catalog.list()).map((integration) => integration.slug)).toContain("first")
      expect(await second.catalog.list()).toEqual([])
    } finally {
      server.stop(true)
    }

    await Promise.all([firstHost.close(), secondHost.close()])
  })
})
