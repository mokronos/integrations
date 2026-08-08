import path from "node:path"
import { createExecutorHost } from "./host.ts"
import type { ExecutorHost, WfExecutor } from "./host.ts"
import type { Effect } from "effect"

const defaultStorageDirectory = (): string =>
  process.env["WF_STORAGE_DIR"] ?? path.join(process.cwd(), ".wf")

let configuredStorageDirectory: string | undefined
const hosts = new Map<string, ExecutorHost>()

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
  const host = hosts.get(resolved)
  if (host === undefined) return
  hosts.delete(resolved)
  await host.close()
}

export const runExecutor = async <A, E>(
  operation: (executor: WfExecutor) => Effect.Effect<A, E>
): Promise<A> =>
  await defaultHost().run(operation)
