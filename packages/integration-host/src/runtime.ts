import { Layer } from "effect"
import { CatalogStore } from "./catalog/store.ts"
import { CredentialStore } from "./storage/credentials.ts"
import { Database, libsqlLayer, memoryLayer } from "./storage/database.ts"
import type { StorageError } from "./errors.ts"
import { IntegrationHost } from "./host.ts"
import { McpHost } from "./mcp/client.ts"
import { OAuthFlows } from "./oauth/flows.ts"
import { OpenApiInvoker } from "./openapi/invoke.ts"
import { SpecCache } from "./openapi/cache.ts"

/** How the host is assembled.
 *
 *  Every capability is its own service with its own dependencies, so the graph
 *  is the composition root and nothing else needs to know the shape of it.
 *
 *  Three seams are named separately because each is worth replacing on its own:
 *  {@link Database} for where rows live, {@link CredentialStore} for where
 *  secrets live, and {@link clientsLayer} for what actually talks to the
 *  network. A Cloudflare deployment replaces the first two; a test replaces the
 *  third and keeps every layer above it — addressing, policy, credential
 *  resolution — as the real thing. */

/** Everything that speaks to an integration. Substituting this is how a test
 *  exercises the host without depending on a vendor's uptime. */
const clientsLayer: Layer.Layer<McpHost | OpenApiInvoker> = Layer.mergeAll(
  McpHost.layer,
  OpenApiInvoker.layer
)

/** The host's own logic, over storage and clients supplied by a caller. */
const capabilitiesLayer: Layer.Layer<
  IntegrationHost | OAuthFlows | SpecCache | CatalogStore,
  never,
  Database | CredentialStore | McpHost | OpenApiInvoker
> = IntegrationHost.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(SpecCache.layer, OAuthFlows.layer)),
  Layer.provideMerge(CatalogStore.layer)
)

/** Every service a fully-composed host exposes. */
type HostLayer = Layer.Layer<
  IntegrationHost | OAuthFlows | SpecCache | CatalogStore | McpHost | OpenApiInvoker,
  StorageError
>

export interface HostStorageOptions {
  /** Directory the SQLite file and the sealed credential file live in. */
  readonly directory: string
}

/** The local host: rows in a SQLite file, secrets in a sealed file beside it. */
export const localLayer = (options: HostStorageOptions): HostLayer =>
  capabilitiesLayer.pipe(
    Layer.provideMerge(clientsLayer),
    Layer.provide(Layer.mergeAll(
      libsqlLayer({ directory: options.directory }),
      CredentialStore.fileLayer(options.directory)
    ))
  )

/** A host over caller-supplied storage — the Cloudflare case, where rows are a
 *  D1 binding and secrets are sealed with the gateway's master key. */
export const hostLayer = <E>(
  storage: Layer.Layer<Database | CredentialStore, E>
): Layer.Layer<
  IntegrationHost | OAuthFlows | SpecCache | CatalogStore | McpHost | OpenApiInvoker,
  E
> =>
  capabilitiesLayer.pipe(
    Layer.provideMerge(clientsLayer),
    Layer.provide(storage)
  )

/** An in-memory host whose integration clients are supplied by the caller.
 *
 *  Storage is merged out as well as in, so a test can assert on what the host
 *  actually wrote — that removing a connection took its credential with it, for
 *  instance — rather than inferring it from behaviour. */
export const stubbedLayer = (
  clients: Layer.Layer<McpHost | OpenApiInvoker>
): Layer.Layer<
  | IntegrationHost
  | OAuthFlows
  | SpecCache
  | CatalogStore
  | McpHost
  | OpenApiInvoker
  | Database
  | CredentialStore,
  StorageError
> =>
  capabilitiesLayer.pipe(
    Layer.provideMerge(clients),
    Layer.provideMerge(Layer.mergeAll(memoryLayer, CredentialStore.memoryLayer))
  )
