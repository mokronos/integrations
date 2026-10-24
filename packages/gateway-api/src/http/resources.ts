import { Effect, Option } from "effect"
import { Base64 } from "effect/encoding"
import {
  blobResourceUri,
  connectionOwner,
  connectionResourceUri,
  connectionSkillUri,
  isDelegationTemplate,
  NotFound,
  parseResourceUri,
  skillResourceScheme
} from "@integragents/contracts"
import type { Alias, BlobId, IntegrationError, Profile, ResourceContents, ResourceEntry } from "@integragents/contracts"
import { BlobStore, Integrations } from "@integragents/integrations"
import type { ConnectionReference } from "@integragents/integrations"
import { GatewayStoreService, listEffectiveTools } from "@integragents/gateway-core"
import type { EffectiveTool } from "@integragents/gateway-core"
import { capture } from "./observability.ts"
import { asCallerFailure } from "./operations.ts"
import { readSkillFile } from "./skills.ts"
import type { GatewayOperationServices } from "./operations.ts"

/** A connection the profile reaches, and the alias its tools and resources go by. */
export interface ProfileConnection {
  readonly alias: Alias
  readonly reference: ConnectionReference
}

/**
 * The connections a profile has a tool on. A delegation template names no
 * person's connection until a call does, so it has no resources of its own.
 */
export const connectionsOf = (effective: ReadonlyArray<EffectiveTool>): ReadonlyArray<ProfileConnection> => {
  const found = new Map<Alias, ConnectionReference>()
  for (const tool of effective) {
    if (isDelegationTemplate(tool.connection)) continue
    found.set(tool.alias, {
      owner: connectionOwner(tool.connection),
      integration: tool.connection.integration,
      name: tool.connection.name
    })
  }
  return [...found].map(([alias, reference]) => ({ alias, reference }))
}

export const profileConnections = (profile: Profile) =>
  Effect.gen(function* () {
    const store = yield* GatewayStoreService
    const integrations = yield* Integrations
    return connectionsOf(yield* capture(listEffectiveTools(store, profile.id, { integrations })))
  })

/** A skill's files keep the address its skill listing gives them; everything else goes under the connection. */
const gatewayUriOf = (alias: Alias, uri: string): string =>
  uri.startsWith(skillResourceScheme) ? connectionSkillUri(alias, uri) : connectionResourceUri(alias, uri)

const addressed = (alias: Alias, resource: ResourceEntry): ResourceEntry => ({
  ...resource,
  uri: gatewayUriOf(alias, resource.uri)
})

const addressedContents = (alias: Alias, contents: ResourceContents): ResourceContents => ({
  ...contents,
  uri: gatewayUriOf(alias, contents.uri)
})

type ResourceOperation<A> = Effect.Effect<A, IntegrationError, GatewayOperationServices>

/**
 * What every connection the profile reaches lists, under the gateway's own
 * URIs. A connection that cannot be listed leaves its resources out rather
 * than failing the rest.
 */
export const listProfileResources = (
  connections: ReadonlyArray<ProfileConnection>
): ResourceOperation<ReadonlyArray<ResourceEntry>> =>
  Effect.gen(function* () {
    const integrations = yield* Integrations
    const listed = yield* Effect.forEach(
      connections,
      (connection) =>
        asCallerFailure(integrations.listResources(connection.reference), connection.reference.integration).pipe(
          Effect.map((resources) => resources.map((resource) => addressed(connection.alias, resource))),
          Effect.catch((failure) =>
            Effect.logWarning("Resources of a connection could not be listed", failure).pipe(
              Effect.annotateLogs({ alias: connection.alias }),
              Effect.as([])
            )
          )
        ),
      { concurrency: 4 }
    )
    return listed.flat()
  })

const readBlob = (uri: string, id: BlobId): ResourceOperation<ReadonlyArray<ResourceContents>> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore
    const opened = yield* blobs.open(id).pipe(Effect.mapError(() => new NotFound({ resource: "blob", id })))
    const bytes = yield* capture(blobs.readAll(id))
    return [{ uri, mimeType: opened.metadata.contentType, blob: Base64.encode(bytes) }]
  })

/**
 * One resource by its gateway URI: a blob the gateway keeps, or what a
 * connection's server serves, read only from a connection the profile reaches.
 */
export const readProfileResource = (
  connections: ReadonlyArray<ProfileConnection>,
  uri: string
): ResourceOperation<ReadonlyArray<ResourceContents>> =>
  Effect.gen(function* () {
    if (uri.startsWith(skillResourceScheme)) return yield* readSkillFile(connections, uri)
    const address = parseResourceUri(uri)
    if (Option.isNone(address)) return yield* new NotFound({ resource: "resource", id: uri })
    const resource = address.value
    if (resource.kind === "blob") return yield* readBlob(blobResourceUri(resource.id), resource.id)
    const connection = connections.find((candidate) => candidate.alias === resource.alias)
    if (connection === undefined) return yield* new NotFound({ resource: "resource", id: uri })
    const integrations = yield* Integrations
    const contents = yield* asCallerFailure(
      integrations.readResource(connection.reference, resource.uri),
      connection.reference.integration
    )
    return contents.map((entry) => addressedContents(connection.alias, entry))
  })
