import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { HttpClient } from "effect/unstable/http"
import path from "node:path"
import { CatalogStore } from "./catalog/store.ts"
import { CredentialStore } from "./storage/credentials.ts"
import { BlobStore } from "./storage/blobs.ts"
import { Database, libsqlLayer, memoryLayer } from "./storage/database.ts"
import type { StorageError } from "./errors.ts"
import { Integrations } from "./integrations.ts"
import { McpClient } from "./mcp/client.ts"
import { OAuthFlows } from "./oauth/flows.ts"
import { OpenApiInvoker } from "./openapi/invoke.ts"
import { SpecCache } from "./openapi/cache.ts"

export const unavailableHttpClientLayer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("Unexpected HTTP request"))
)

const clientsLayer: Layer.Layer<
  McpClient | OpenApiInvoker,
  never,
  HttpClient.HttpClient | BlobStore
> = Layer.mergeAll(McpClient.layer, OpenApiInvoker.layer)

const capabilitiesLayer: Layer.Layer<
  Integrations | OAuthFlows | SpecCache | CatalogStore,
  never,
  Database | CredentialStore | HttpClient.HttpClient | McpClient | OpenApiInvoker
> = Integrations.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(SpecCache.layer, OAuthFlows.layer)),
  Layer.provideMerge(CatalogStore.layer)
)

type IntegrationLayer = Layer.Layer<
  Integrations | OAuthFlows | SpecCache | CatalogStore | McpClient | OpenApiInvoker | BlobStore,
  StorageError,
  HttpClient.HttpClient
>

export interface IntegrationStorageOptions {
  readonly directory: string
}

export const localLayer = (options: IntegrationStorageOptions): IntegrationLayer =>
  capabilitiesLayer.pipe(
    Layer.provideMerge(clientsLayer),
    Layer.provideMerge(BlobStore.fileLayer(options.directory)),
    Layer.provide(Layer.mergeAll(
      libsqlLayer({ directory: options.directory }),
      CredentialStore.fileLayer(options.directory)
    ))
  )

export const integrationLayer = <E>(
  storage: Layer.Layer<Database | CredentialStore, E>,
  blobs: Layer.Layer<BlobStore>
): Layer.Layer<
  Integrations | OAuthFlows | SpecCache | CatalogStore | McpClient | OpenApiInvoker | BlobStore,
  E,
  HttpClient.HttpClient
> =>
  capabilitiesLayer.pipe(
    Layer.provideMerge(clientsLayer),
    Layer.provideMerge(blobs),
    Layer.provide(storage)
  )

export const stubbedLayer = (
  clients: Layer.Layer<McpClient | OpenApiInvoker>
): Layer.Layer<
  | Integrations
  | OAuthFlows
  | SpecCache
  | CatalogStore
  | McpClient
  | OpenApiInvoker
  | Database
  | CredentialStore,
  StorageError
> =>
  capabilitiesLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(clients, unavailableHttpClientLayer)),
    Layer.provideMerge(Layer.mergeAll(memoryLayer, CredentialStore.memoryLayer))
  )

export type IntegrationServices =
  | Integrations
  | McpClient
  | OAuthFlows
  | OpenApiInvoker
  | SpecCache
  | CatalogStore
  | BlobStore

export interface IntegrationStorage {
  readonly storage?: Layer.Layer<Database | CredentialStore, StorageError>
}

export const createIntegrationRuntime = (
  directory: string,
  httpClient: Layer.Layer<HttpClient.HttpClient>,
  storage: IntegrationStorage = {}
): ManagedRuntime.ManagedRuntime<IntegrationServices, StorageError> =>
  ManagedRuntime.make(
    (storage.storage === undefined
      ? localLayer({ directory: path.resolve(directory) })
      : integrationLayer(
        storage.storage,
        BlobStore.fileLayer(path.resolve(directory))
      )).pipe(Layer.provide(httpClient))
  )

export const integrationServicesOf = (
  runtime: ManagedRuntime.ManagedRuntime<IntegrationServices, StorageError>
): Promise<Context.Context<IntegrationServices>> =>
  runtime.runPromise(Effect.context<IntegrationServices>())
