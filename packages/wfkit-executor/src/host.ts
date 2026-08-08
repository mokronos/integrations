import { mkdirSync } from "node:fs"
import path from "node:path"
import { createClient } from "@libsql/client"
import {
  createDrizzleRuntimeSchemaFromTables,
  ensureDrizzleRuntimeSchemaFromTables
} from "@executor-js/fumadb/adapters/drizzle"
import { mcpPlugin } from "@executor-js/plugin-mcp/core"
import { openApiPlugin } from "@executor-js/plugin-openapi/core"
import {
  createExecutor,
  type Executor,
  Tenant
} from "@executor-js/sdk/core"
import { createExecutorFumaDb } from "@executor-js/sdk/host-internal"
import { drizzle } from "drizzle-orm/libsql"
import { Effect } from "effect"
import { fileCredentialProvider } from "./credential-provider.ts"

const plugins = [
  mcpPlugin({ dangerouslyAllowStdioMCP: false }),
  openApiPlugin()
] as const

export type WfExecutor = Executor<typeof plugins>

const defaultStorageDirectory = (): string =>
  process.env["WF_STORAGE_DIR"] ?? path.join(process.cwd(), ".wf")

let configuredStorageDirectory: string | undefined
const hosts = new Map<string, ExecutorHost>()
export const setExecutorStorageDirectory = (directory: string): void => {
  configuredStorageDirectory = path.resolve(directory)
}

export const executorStorageDirectory = (): string =>
  configuredStorageDirectory ?? path.resolve(defaultStorageDirectory())

const makeExecutor = async (directory: string): Promise<WfExecutor> => {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return await Effect.runPromise(createExecutor({
    tenant: Tenant.make("wf-local"),
    plugins,
    providers: [fileCredentialProvider(directory)],
    onElicitation: "accept-all",
    db: ({ tables }) => Effect.promise(async () => {
      const databasePath = path.join(directory, "executor.sqlite")
      const client = createClient({ url: `file:${databasePath}` })
      await client.execute("PRAGMA foreign_keys = ON")
      await client.execute("PRAGMA journal_mode = WAL")
      const schema = createDrizzleRuntimeSchemaFromTables({
        tables,
        namespace: "wf_executor",
        version: "1.0.0",
        provider: "sqlite"
      })
      const drizzleDatabase = drizzle({ client, schema })
      await ensureDrizzleRuntimeSchemaFromTables(drizzleDatabase, {
        tables,
        namespace: "wf_executor",
        version: "1.0.0",
        provider: "sqlite"
      })
      const handle = createExecutorFumaDb(drizzleDatabase, {
        tables,
        namespace: "wf_executor",
        version: "1.0.0",
        provider: "sqlite"
      })
      return {
        db: handle.db,
        close: async () => client.close()
      }
    })
  }))
}

export interface ExecutorHost {
  readonly directory: string
  executor(): Promise<WfExecutor>
  run<A, E>(operation: (executor: WfExecutor) => Effect.Effect<A, E>): Promise<A>
  close(): Promise<void>
}

/** Owns one Executor instance and its storage resources for an explicit
 * directory. Construction is lazy; close releases the database handle. */
export const createExecutorHost = (directory: string): ExecutorHost => {
  const resolvedDirectory = path.resolve(directory)
  let pending: Promise<WfExecutor> | undefined

  const executor = (): Promise<WfExecutor> => {
    if (pending !== undefined) return pending
    const created = makeExecutor(resolvedDirectory)
    pending = created
    void created.catch(() => {
      if (pending === created) pending = undefined
    })
    return created
  }

  return {
    directory: resolvedDirectory,
    executor,
    run: async (operation) => await Effect.runPromise(operation(await executor())),
    close: async () => {
      const active = pending
      pending = undefined
      if (active !== undefined) {
        await Effect.runPromise((await active).close())
      }
    }
  }
}

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
