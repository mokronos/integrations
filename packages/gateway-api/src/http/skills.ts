import { skillEntry } from "@modelcontextprotocol/server/ext/skills"
import { Effect, Option, Schema } from "effect"
import {
  connectionSkillUri,
  gatewaySkillAuthority,
  NotFound,
  parseSkillUri,
  SkillEntry,
  skillResourceScheme
} from "@integragents/contracts"
import type { Alias, IntegrationError, ResourceContents } from "@integragents/contracts"
import { Integrations } from "@integragents/integrations"
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
