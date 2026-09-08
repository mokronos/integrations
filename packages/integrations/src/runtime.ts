import { Context, Effect, Layer, ManagedRuntime } from "effect"
import path from "node:path"
import { CatalogStore } from "./catalog/store.ts"
import { CredentialStore } from "./storage/credentials.ts"
import { Database, libsqlLayer, memoryLayer } from "./storage/database.ts"
import type { StorageError } from "./errors.ts"
import { IntegrationHost } from "./host.ts"
import { McpHost } from "./mcp/client.ts"
import { OAuthFlows } from "./oauth/flows.ts"
import { OpenApiInvoker } from "./openapi/invoke.ts"
import { SpecCache } from "./openapi/cache.ts"
import { HttpTransport } from "./http-transport.ts"

const clientsLayer: Layer.Layer<McpHost | OpenApiInvoker> = Layer.mergeAll(
  McpHost.layer,
  OpenApiInvoker.layer.pipe(Layer.provide(HttpTransport.layer))
)

const capabilitiesLayer: Layer.Layer<
  IntegrationHost | OAuthFlows | SpecCache | CatalogStore,
  never,
  Database | CredentialStore | HttpTransport | McpHost | OpenApiInvoker
> = IntegrationHost.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(SpecCache.layer, OAuthFlows.layer)),
  Layer.provideMerge(CatalogStore.layer)
)

type HostLayer = Layer.Layer<
  IntegrationHost | OAuthFlows | SpecCache | CatalogStore | McpHost | OpenApiInvoker,
  StorageError
>

export interface HostStorageOptions {
  readonly directory: string
}

export const localLayer = (options: HostStorageOptions): HostLayer =>
  capabilitiesLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(clientsLayer, HttpTransport.layer)),
    Layer.provide(Layer.mergeAll(
      libsqlLayer({ directory: options.directory }),
      CredentialStore.fileLayer(options.directory)
    ))
  )

export const hostLayer = <E>(
  storage: Layer.Layer<Database | CredentialStore, E>
): Layer.Layer<
  IntegrationHost | OAuthFlows | SpecCache | CatalogStore | McpHost | OpenApiInvoker,
  E
> =>
  capabilitiesLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(clientsLayer, HttpTransport.layer)),
    Layer.provide(storage)
  )

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
    Layer.provideMerge(Layer.mergeAll(clients, HttpTransport.unavailableTestLayer)),
    Layer.provideMerge(Layer.mergeAll(memoryLayer, CredentialStore.memoryLayer))
  )

export type HostServices =
  | IntegrationHost
  | McpHost
  | OAuthFlows
  | OpenApiInvoker
  | SpecCache
  | CatalogStore

export interface HostStorage {
  readonly storage?: Layer.Layer<Database | CredentialStore, StorageError>
}

export const createHostRuntime = (
  directory: string,
  storage: HostStorage = {}
): ManagedRuntime.ManagedRuntime<HostServices, StorageError> =>
  ManagedRuntime.make(
    storage.storage === undefined
      ? localLayer({ directory: path.resolve(directory) })
      : hostLayer(storage.storage)
  )

export const hostServicesOf = (
  runtime: ManagedRuntime.ManagedRuntime<HostServices, StorageError>
): Promise<Context.Context<HostServices>> =>
  runtime.runPromise(Effect.context<HostServices>())
