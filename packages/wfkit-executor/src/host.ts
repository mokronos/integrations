import { mkdirSync } from "node:fs"
import path from "node:path"
import { createClient } from "@libsql/client"
import {
  createDrizzleRuntimeSchemaFromTables,
  ensureDrizzleRuntimeSchemaFromTables
} from "@executor-js/fumadb/adapters/drizzle"
import { mcpPlugin } from "@executor-js/plugin-mcp/core"
import { openApiPlugin } from "@executor-js/plugin-openapi/core"
import { googleDiscoveryAdapter } from "@executor-js/plugin-openapi/providers/google"
import {
  createExecutor,
  type CredentialProvider,
  type ExecutorDbFactory,
  type Executor,
  Tenant
} from "@executor-js/sdk/core"
import { createExecutorFumaDb } from "@executor-js/sdk/host-internal"
import { drizzle } from "drizzle-orm/libsql"
import { Context, Effect, Layer, Schema } from "effect"
import { fileCredentialProvider } from "./credential-provider.ts"

const plugins = [
  mcpPlugin({ dangerouslyAllowStdioMCP: false }),
  openApiPlugin({
    // Google publishes its APIs as Discovery documents, not OpenAPI; the
    // adapter converts them so `specFormat: "google-discovery"` specs load
    // like any other.
    specFormats: [googleDiscoveryAdapter]
  })
] as const

export type WfExecutor = Executor<typeof plugins>

/** Storage overrides for hosts whose storage is not a directory on disk —
 *  Cloudflare D1, an in-memory test client. Everything unset keeps the
 *  historical behaviour: credentials and SQLite in `directory`. */
export interface ExecutorHostStorage {
  /** Replaces the default file-backed credential provider. */
  readonly providers?: ReadonlyArray<CredentialProvider>
  /** Replaces the default per-directory SQLite database: receives the runtime
   *  table definitions and returns the FumaDb handle createExecutor expects.
   *  When supplied, no directory is created. */
  readonly buildDatabase?: ExecutorDbFactory
}

const defaultDatabase = (directory: string): ExecutorDbFactory =>
  ({ tables }) => Effect.promise(async () => {
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

const makeExecutor = async (
  directory: string,
  storage: ExecutorHostStorage = {}
): Promise<WfExecutor> => {
  // The default database lives in the directory; a replacement owns its own
  // location entirely, so creating the directory would be dead weight.
  if (storage.buildDatabase === undefined) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  return await Effect.runPromise(createExecutor({
    tenant: Tenant.make("wf-local"),
    plugins,
    providers: storage.providers ?? [fileCredentialProvider(directory)],
    onElicitation: "accept-all",
    db: storage.buildDatabase ?? defaultDatabase(directory)
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

/** Effect capability for an explicitly owned Executor host. The layer brackets
 * the host even though Executor construction itself stays lazy. */
export class ExecutorHostService extends Context.Service<
  ExecutorHostService,
  ExecutorHost
>()("@mokronos/wfkit-executor/ExecutorHost") {
  static readonly layer = (
    directory: string,
    storage?: ExecutorHostStorage
  ): Layer.Layer<ExecutorHostService> =>
    Layer.effect(
      ExecutorHostService,
      Effect.acquireRelease(
        Effect.sync(() => createExecutorHost(directory, storage)),
        (host) => Effect.promise(() => host.close())
      )
    )
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
 *  directory. Construction is lazy; close releases the database handle. */
export const createExecutorHost = (
  directory: string,
  storage: ExecutorHostStorage = {}
): ExecutorHost => {
  const resolvedDirectory = path.resolve(directory)
  let pending: Promise<WfExecutor> | undefined
  let closed = false
  let closePromise: Promise<void> | undefined

  const executor = (): Promise<WfExecutor> => {
    if (closed) {
      return Promise.reject(new ExecutorHostClosedError({ directory: resolvedDirectory }))
    }
    if (pending !== undefined) return pending
    const created = makeExecutor(resolvedDirectory, storage)
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
      if (closePromise !== undefined) return closePromise
      closed = true
      const active = pending
      pending = undefined
      closePromise = active === undefined
        ? Promise.resolve()
        : active.then((executor) => Effect.runPromise(executor.close()))
      await closePromise
    }
  }
}
