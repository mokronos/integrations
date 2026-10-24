import { SkillsExtension } from "@modelcontextprotocol/server/ext/skills"
import type { Skill, SkillSource } from "@modelcontextprotocol/server/ext/skills"
import type { McpServer } from "@modelcontextprotocol/server"
import { Effect, Option, Result } from "effect"
import { Base64 } from "effect/encoding"
import { whenPresent } from "@integragents/contracts"
import type { SkillEntry } from "@integragents/contracts"
import type { ResourceRun } from "./mcp-resources.ts"
import type { ProfileConnection } from "./resources.ts"
import { getProfileSkill, listProfileSkills, readSkillFile } from "./skills.ts"

const wireSkill = ({ meta, frontmatter, resources, uri }: SkillEntry): Skill => ({
  uri,
  frontmatter: { ...frontmatter },
  resources: resources === "dynamic" ? "dynamic" : resources.map((file) => ({ ...file })),
  ...whenPresent("_meta", meta)
})

/**
 * The profile's skills through the SDK's Skills extension: the gateway's own,
 * and those of every connection the profile has a tool on, in one listing.
 */
const profileSkillSource = (run: ResourceRun, connections: ReadonlyArray<ProfileConnection>): SkillSource => ({
  list: (_params, context) =>
    run(
      Effect.map(listProfileSkills(connections), (skills) => ({ skills: skills.map(wireSkill) })),
      context
    ),
  get: (uri, context) =>
    run(
      Effect.map(getProfileSkill(connections, uri), (found) => Option.getOrUndefined(Option.map(found, wireSkill))),
      context
    ),
  read: (uri, context) =>
    run(
      Effect.map(
        readSkillFile(connections, uri).pipe(Effect.catchTag("NotFound", () => Effect.succeed([]))),
        ([contents]) => {
          if (contents === undefined) return undefined
          if ("text" in contents) return { text: contents.text, ...whenPresent("mimeType", contents.mimeType) }
          return Result.match(Base64.decode(contents.blob), {
            onFailure: () => undefined,
            onSuccess: (bytes) => ({ bytes, ...whenPresent("mimeType", contents.mimeType) })
          })
        }
      ),
      context
    )
})

export const serveSkills = (server: McpServer, run: ResourceRun, connections: ReadonlyArray<ProfileConnection>) =>
  new SkillsExtension({ source: profileSkillSource(run, connections) }).attach(server)
