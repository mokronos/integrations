import path from "node:path"
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { CatalogStore } from "../catalog/store.ts"
import { CredentialStore } from "../storage/credentials.ts"
import { Database } from "../storage/database.ts"
import type { StorageError } from "../errors.ts"
import { IntegrationHost } from "../host.ts"
import { McpHost } from "../mcp/client.ts"
import { OAuthFlows } from "../oauth/flows.ts"
import { OpenApiInvoker } from "../openapi/invoke.ts"
import { hostLayer, localLayer } from "../runtime.ts"
import { SpecCache } from "../openapi/cache.ts"

/** Owning one host and its storage for the lifetime of a process.
 *
 *  Everything inside this package is Effect. The gateway that consumes it is
 *  not — it is an async/await HTTP service — so this is the one place the two
 *  meet. A `ManagedRuntime` builds the layer graph once and runs individual
 *  effects against it, which is what keeps a per-request call from reopening the
 *  database. */

/** Every service a host operation may reach for. */
export type HostServices =
  | IntegrationHost
  | McpHost
  | OAuthFlows
  | OpenApiInvoker
  | SpecCache
  | CatalogStore

/** Replaces where a host keeps its rows and its secrets. Everything unset keeps
 *  the local behaviour: SQLite and a sealed credential file in `directory`. */
export interface HostStorage {
  /** Supplies both storage seams — a Cloudflare D1 binding and a master-key
   *  credential store, for instance. When present, no directory is created. */
  readonly storage?: Layer.Layer<Database | CredentialStore, StorageError>
}

export interface HostHandle {
  readonly directory: string
  /** Runs one host operation. */
  run<A, E>(operation: Effect.Effect<A, E, HostServices>): Promise<A>
  close(): Promise<void>
}

export class HostClosedError extends Schema.TaggedError<HostClosedError>()(
  "HostClosedError",
  { directory: Schema.String }
) {
  override get message(): string {
    return `The integration host for ${this.directory} has been closed`
  }
}

/** Composes one host over an explicit directory. Storage is opened lazily, on
 *  the first operation, so constructing a host costs nothing. */
export const createHostHandle = (
  directory: string,
  storage: HostStorage = {}
): HostHandle => {
  const resolvedDirectory = path.resolve(directory)
  const layer = storage.storage === undefined
    ? localLayer({ directory: resolvedDirectory })
    : hostLayer(storage.storage)

  let runtime: ManagedRuntime.ManagedRuntime<HostServices, StorageError> | undefined
  let closed = false
  let closing: Promise<void> | undefined

  const current = () => {
    if (runtime === undefined) runtime = ManagedRuntime.make(layer)
    return runtime
  }

  return {
    directory: resolvedDirectory,
    run: async (operation) => {
      if (closed) {
        throw new HostClosedError({ directory: resolvedDirectory })
      }
      return await current().runPromise(operation)
    },
    close: async () => {
      if (closing !== undefined) return closing
      closed = true
      const active = runtime
      runtime = undefined
      closing = active === undefined ? Promise.resolve() : active.dispose()
      await closing
    }
  }
}

/** Effect capability for a host, for a caller that is already inside Effect and
 *  wants the services rather than the Promise facade. */
export class HostHandleService extends Context.Service<
  HostHandleService,
  HostHandle
>()("@mokronos/integration-host/HostHandle") {
  static readonly layer = (
    directory: string,
    storage?: HostStorage
  ): Layer.Layer<HostHandleService> =>
    Layer.effect(
      HostHandleService,
      Effect.acquireRelease(
        Effect.sync(() => createHostHandle(directory, storage)),
        (host) => Effect.promise(() => host.close())
      )
    )
}
