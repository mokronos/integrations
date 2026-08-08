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
    expect(services.integrationInvoker.invoke).toBeFunction()

    await host.close()
  })
})
