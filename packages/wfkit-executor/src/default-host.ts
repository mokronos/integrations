import path from "node:path"
import { createExecutorHost } from "./host.ts"
import type { ExecutorHost, WfExecutor } from "./host.ts"
import type { Effect } from "effect"

const defaultStorageDirectory = (): string =>
  process.env["WF_STORAGE_DIR"] ?? path.join(process.cwd(), ".wf")

let configuredStorageDirectory: string | undefined
const hosts = new Map<string, ExecutorHost>()
const closingHosts = new Map<string, Promise<void>>()

export const setExecutorStorageDirectory = (directory: string): void => {
  configuredStorageDirectory = path.resolve(directory)
}

export const executorStorageDirectory = (): string =>
  configuredStorageDirectory ?? path.resolve(defaultStorageDirectory())

const defaultHost = (): ExecutorHost => {
  const directory = executorStorageDirectory()
  const existing = hosts.get(directory)
  if (existing !== undefined) return existing
  const created = createExecutorHost(directory)
  hosts.set(directory, created)
  return created
}

export const getExecutor = (): Promise<WfExecutor> => defaultHost().executor()

export const closeExecutor = async (directory?: string): Promise<void> => {
  const resolved = path.resolve(directory ?? executorStorageDirectory())
  const closing = closingHosts.get(resolved)
  if (closing !== undefined) return closing
  const host = hosts.get(resolved)
  if (host === undefined) return
  const promise = host.close().finally(() => {
    if (hosts.get(resolved) === host) hosts.delete(resolved)
    closingHosts.delete(resolved)
  })
  closingHosts.set(resolved, promise)
  await promise
}

export const runExecutor = async <A, E>(
  operation: (executor: WfExecutor) => Effect.Effect<A, E>
): Promise<A> =>
  await defaultHost().run(operation)
