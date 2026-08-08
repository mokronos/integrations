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
import { Effect, Schema } from "effect"
import { fileCredentialProvider } from "./credential-provider.ts"

const plugins = [
  mcpPlugin({ dangerouslyAllowStdioMCP: false }),
  openApiPlugin()
] as const

export type WfExecutor = Executor<typeof plugins>

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

export interface ExecutorRunner {
  run<A, E>(operation: (executor: WfExecutor) => Effect.Effect<A, E>): Promise<A>
}

export interface ExecutorHost extends ExecutorRunner {
  readonly directory: string
  executor(): Promise<WfExecutor>
  close(): Promise<void>
}

export class ExecutorHostClosedError extends Schema.TaggedErrorClass<ExecutorHostClosedError>()(
  "ExecutorHostClosedError",
  { directory: Schema.String }
) {
  override get message(): string {
    return `Executor host for ${this.directory} has been closed`
  }
}

/** Owns one Executor instance and its storage resources for an explicit
 * directory. Construction is lazy; close releases the database handle. */
export const createExecutorHost = (directory: string): ExecutorHost => {
  const resolvedDirectory = path.resolve(directory)
  let pending: Promise<WfExecutor> | undefined
  let closed = false

  const executor = (): Promise<WfExecutor> => {
    if (closed) {
      return Promise.reject(new ExecutorHostClosedError({ directory: resolvedDirectory }))
    }
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
      if (closed) return
      closed = true
      const active = pending
      pending = undefined
      if (active !== undefined) {
        await Effect.runPromise((await active).close())
      }
    }
  }
}
