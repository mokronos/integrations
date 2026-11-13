import { skillEntry } from "@modelcontextprotocol/server/ext/skills"
import { Effect, Option, Schema } from "effect"
import {
  connectionSkillUri,
  gatewaySkillAuthority,
  NotFound,
  parseSkillUri,
  SkillEntry,
  skillResourceScheme,
  whenPresent
} from "@integragents/contracts"
import type {
  Alias,
  ConnectionSkill,
  IntegrationError,
  IntegrationSlug,
  IntegrationSkillsResponse,
  ResourceContents
} from "@integragents/contracts"
import { Integrations } from "@integragents/integrations"
import { capture } from "./observability.ts"
import { asCallerFailure } from "./operations.ts"
import type { GatewayOperationServices } from "./operations.ts"
import type { ProfileConnection } from "./resources.ts"
import { integrationsMcpSkill } from "./skills/integrations-mcp.ts"

type SkillOperation<A> = Effect.Effect<A, IntegrationError, GatewayOperationServices>

const ownSkillPath = `${gatewaySkillAuthority}/integrations-mcp`
const ownSkillUri = `${skillResourceScheme}${ownSkillPath}/SKILL.md`

const decodeSkill = Schema.decodeUnknownEffect(SkillEntry)

/** The gateway's own skill, with the digest the SDK computes over its one file. */
const ownSkill = Effect.promise(() => skillEntry(ownSkillPath, { "SKILL.md": integrationsMcpSkill })).pipe(
  Effect.flatMap(({ uri, frontmatter, resources }) => decodeSkill({ uri, frontmatter, resources })),
  Effect.orDie
)

/** A connection's skill under the connection's alias, every file of it re-addressed. */
const addressed = (alias: Alias, skill: SkillEntry): SkillEntry => ({
  ...skill,
  uri: connectionSkillUri(alias, skill.uri),
  resources:
    skill.resources === "dynamic"
      ? "dynamic"
      : skill.resources.map((file) => ({ ...file, uri: connectionSkillUri(alias, file.uri) }))
})

/**
 * Every skill this profile can reach in one listing: the gateway's own, then
 * each connection's server's, under the connection's alias. A server that
 * cannot be asked leaves its skills out rather than failing the rest.
 */
export const listProfileSkills = (
  connections: ReadonlyArray<ProfileConnection>
): SkillOperation<ReadonlyArray<SkillEntry>> =>
  Effect.gen(function* () {
    const integrations = yield* Integrations
    const upstream = yield* Effect.forEach(
      connections,
      (connection) =>
        asCallerFailure(integrations.listSkills(connection.reference), connection.reference.integration).pipe(
          Effect.map((skills) => skills.map((skill) => addressed(connection.alias, skill))),
          Effect.catch((failure) =>
            Effect.logWarning("Skills of a connection could not be listed", failure).pipe(
              Effect.annotateLogs({ alias: connection.alias }),
              Effect.as([])
            )
          )
        ),
      { concurrency: 4 }
    )
    return [yield* ownSkill, ...upstream.flat()]
  })

const connectionOf = (connections: ReadonlyArray<ProfileConnection>, alias: Alias) =>
  Option.fromNullishOr(connections.find((candidate) => candidate.alias === alias))

/** One skill by the URI of its `SKILL.md`, listed or not; none for a URI this profile cannot reach. */
export const getProfileSkill = (
  connections: ReadonlyArray<ProfileConnection>,
  uri: string
): SkillOperation<Option.Option<SkillEntry>> =>
  Effect.gen(function* () {
    if (uri === ownSkillUri) return Option.some(yield* ownSkill)
    const named = parseSkillUri(uri)
    const connection = Option.flatMap(named, (skill) => connectionOf(connections, skill.alias))
    if (Option.isNone(named) || Option.isNone(connection)) return Option.none()
    const integrations = yield* Integrations
    const found = yield* asCallerFailure(
      integrations.getSkill(connection.value.reference, named.value.uri),
      connection.value.reference.integration
    )
    return Option.map(found, (skill) => addressed(connection.value.alias, skill))
  })

/** One file of a skill this profile can reach, with the URI it was asked for. */
export const readSkillFile = (
  connections: ReadonlyArray<ProfileConnection>,
  uri: string
): SkillOperation<ReadonlyArray<ResourceContents>> =>
  Effect.gen(function* () {
    if (uri === ownSkillUri) return [{ uri, mimeType: "text/markdown", text: integrationsMcpSkill }]
    const named = parseSkillUri(uri)
    const connection = Option.flatMap(named, (skill) => connectionOf(connections, skill.alias))
    if (Option.isNone(named) || Option.isNone(connection)) {
      return yield* new NotFound({ resource: "resource", id: uri })
    }
    const integrations = yield* Integrations
    const contents = yield* asCallerFailure(
      integrations.readResource(connection.value.reference, named.value.uri),
      connection.value.reference.integration
    )
    return contents.map((entry) => ({ ...entry, uri }))
  })

interface ConnectionSkills {
  readonly skills: ReadonlyArray<ConnectionSkill>
  readonly error?: string
}

/**
 * The skills each of an integration's connections' servers publishes, asked
 * live, for the dashboard to show beside its tools. A server that cannot be
 * asked is named in `error` rather than failing the rest.
 */
export const listIntegrationSkills = (slug: IntegrationSlug) =>
  Effect.gen(function* () {
    const integrations = yield* Integrations
    const found = yield* capture(integrations.findIntegration(slug))
    if (Option.isNone(found)) return yield* new NotFound({ resource: "integration", id: slug })
    const connections = yield* capture(integrations.listConnections({ integration: slug }))
    const listed = yield* Effect.forEach(
      connections,
      (connection) =>
        asCallerFailure(
          integrations.listSkills({ owner: connection.owner, integration: slug, name: connection.name }),
          slug
        ).pipe(
          Effect.map((skills): ConnectionSkills => ({
            skills: skills.map((skill) => ({ owner: connection.owner, connection: connection.name, skill }))
          })),
          Effect.catch((failure) =>
            Effect.succeed<ConnectionSkills>({ skills: [], error: `${connection.name}: ${failure.message}` })
          )
        ),
      { concurrency: 4 }
    )
    const errors = listed.flatMap((entry) => (entry.error === undefined ? [] : [entry.error]))
    const response: IntegrationSkillsResponse = {
      skills: listed.flatMap((entry) => entry.skills),
      ...whenPresent("error", errors.length === 0 ? undefined : errors.join("; "))
    }
    return response
  })
