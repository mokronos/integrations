import { ResourceTemplate } from "@modelcontextprotocol/server"
import type { McpServer, ReadResourceResult, Resource, ServerContext } from "@modelcontextprotocol/server"
import { Effect } from "effect"
import { blobResourcePrefix, connectionResourcePrefix, uiResourceScheme, whenPresent } from "@integragents/contracts"
import type { GatewayError, ResourceContents, ResourceEntry } from "@integragents/contracts"
import type { GatewayOperationServices } from "./operations.ts"
import { listProfileResources, readProfileResource } from "./resources.ts"
import type { ProfileConnection } from "./resources.ts"

export type ResourceRun = <A>(
  effect: Effect.Effect<A, GatewayError, GatewayOperationServices>,
  context: ServerContext
) => Promise<A>

const wireResource = (resource: ResourceEntry): Resource => ({
  uri: resource.uri,
  name: resource.name,
  ...whenPresent("title", resource.title),
  ...whenPresent("description", resource.description),
  ...whenPresent("mimeType", resource.mimeType),
  ...whenPresent("size", resource.size),
  ...whenPresent("_meta", resource.meta)
})

const wireContents = (contents: ResourceContents): ReadResourceResult["contents"][number] => {
  const shared = {
    uri: contents.uri,
    ...whenPresent("mimeType", contents.mimeType),
    ...whenPresent("_meta", contents.meta)
  }
  return "text" in contents ? { ...shared, text: contents.text } : { ...shared, blob: contents.blob }
}

/**
 * Serves the gateway's blobs and, under each connection's alias, the
 * resources its server lists, including the `ui://` views MCP Apps render.
 */
export const serveResources = (
  server: McpServer,
  run: ResourceRun,
  connections: ReadonlyArray<ProfileConnection>
): void => {
  const read = (uri: URL, context: ServerContext): Promise<ReadResourceResult> =>
    run(
      Effect.map(readProfileResource(connections, uri.href), (contents) => ({ contents: contents.map(wireContents) })),
      context
    )
  server.registerResource(
    "connection-resources",
    new ResourceTemplate(`${connectionResourcePrefix}{alias}/{uri}`, {
      list: (context) =>
        run(
          Effect.map(listProfileResources(connections), (resources) => ({ resources: resources.map(wireResource) })),
          context
        )
    }),
    { description: "Resources the servers of this profile's connections serve, under each connection's alias." },
    (uri, _variables, context) => read(uri, context)
  )
  server.registerResource(
    "connection-views",
    new ResourceTemplate(`${uiResourceScheme}{alias}/{+path}`, { list: undefined }),
    { description: "MCP App views the servers of this profile's connections serve." },
    (uri, _variables, context) => read(uri, context)
  )
  server.registerResource(
    "blobs",
    new ResourceTemplate(`${blobResourcePrefix}{id}`, { list: undefined }),
    { description: "Files and media tool results carried, kept by the gateway." },
    (uri, _variables, context) => read(uri, context)
  )
}
