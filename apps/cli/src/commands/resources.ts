import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect, Option, Result } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { Base64 } from "effect/encoding"
import { AppSessionId, whenPresent } from "@integragents/contracts"
import type { ResourceContents } from "@integragents/contracts"
import { integrationsHome } from "@integragents/contracts/gateway-config"
import { cliError, thrownMessage } from "../connection.ts"
import type { IntegrationsCliError } from "../connection.ts"
import { jsonOutput, writeStdoutLine } from "../output.ts"
import { gatewayTask } from "../tasks.ts"

const verboseFlag = () =>
  Flag.Boolean("verbose").pipe(
    Flag.withDefault(false),
    Flag.withAlias("v"),
    Flag.withDescription("Show complete objects, pretty-printed")
  )

/** A file name for bytes read from `uri`, kept inside the download directory. */
const fileNameOf = (uri: string): string => {
  const last =
    uri
      .split(/[/:]/)
      .filter((part) => part.length > 0)
      .pop() ?? "resource"
  return decodeURIComponent(last).replace(/[^\w.-]+/g, "_")
}

/** Bytes go to disk, where they can be opened, rather than into the agent's context as base64. */
const written = (
  contents: ResourceContents,
  out: string | undefined
): Effect.Effect<
  ResourceContents | { readonly uri: string; readonly mimeType?: string; readonly path: string },
  IntegrationsCliError
> => {
  if ("text" in contents) return Effect.succeed(contents)
  const destination =
    out === undefined ? path.join(integrationsHome(), "downloads", fileNameOf(contents.uri)) : path.resolve(out)
  return Result.match(Base64.decode(contents.blob), {
    onFailure: () => Effect.fail(cliError(`The gateway sent ${contents.uri} as something other than base64`)),
    onSuccess: (bytes) =>
      Effect.try({
        try: () => {
          mkdirSync(path.dirname(destination), { recursive: true })
          writeFileSync(destination, bytes)
          return {
            uri: contents.uri,
            ...whenPresent("mimeType", contents.mimeType),
            path: destination
          }
        },
        // oxlint-disable-next-line anti-slop/no-unknown-parameters
        catch: (cause: unknown) => cliError(thrownMessage(cause))
      })
  })
}

export const resourcesCommand = Command.make("resources", { verbose: verboseFlag() }, ({ verbose }) =>
  gatewayTask((client) => client.delegated.listResources()).pipe(
    Effect.flatMap((listed) => writeStdoutLine(jsonOutput(listed, verbose)))
  )
).pipe(
  Command.withDescription(
    "List the resources the servers of your connections serve, and the gateway URI to read each by"
  )
)

export const resourceCommand = Command.make(
  "resource",
  {
    uri: Argument.String("uri").pipe(Argument.withDescription("The gateway URI `resources` lists")),
    out: Flag.String("out").pipe(Flag.optional, Flag.withDescription("Write binary contents to this path")),
    verbose: verboseFlag()
  },
  ({ uri, out, verbose }) =>
    gatewayTask((client) => client.delegated.readResource({ query: { uri } })).pipe(
      Effect.flatMap(({ contents }) => Effect.forEach(contents, (entry) => written(entry, Option.getOrUndefined(out)))),
      Effect.flatMap((contents) => writeStdoutLine(jsonOutput({ contents }, verbose)))
    )
).pipe(Command.withDescription("Read one resource by its gateway URI; binary contents are written to disk"))

export const skillsCommand = Command.make("skills", { verbose: verboseFlag() }, ({ verbose }) =>
  gatewayTask((client) => client.delegated.listSkills()).pipe(
    Effect.flatMap((listed) => writeStdoutLine(jsonOutput(listed, verbose)))
  )
).pipe(
  Command.withDescription(
    "List the skills the gateway and your connections' servers publish; read a skill's files with `resource <uri>`"
  )
)

export const appCommand = Command.make(
  "app",
  {
    session: Argument.String("session").pipe(Argument.withDescription("The app session a tool result carried")),
    verbose: verboseFlag()
  },
  ({ session, verbose }) =>
    gatewayTask((client) => client.apps.appNotes({ params: { id: AppSessionId.make(session) } })).pipe(
      Effect.flatMap((notes) => writeStdoutLine(jsonOutput(notes, verbose)))
    )
).pipe(
  Command.withDescription(
    "Read what a tool's MCP App, opened by a person from its dashboard link, asked to tell you: its context and messages"
  )
)
