import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect, Option, Result, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { Base64 } from "effect/encoding"
import { Alias, AppSessionId, JsonObjectSchema, whenPresent } from "@integragents/contracts"
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

export const eventsCommand = Command.make("events", { verbose: verboseFlag() }, ({ verbose }) =>
  gatewayTask((client) => client.delegated.listEventTypes()).pipe(
    Effect.flatMap((listed) => writeStdoutLine(jsonOutput(listed, verbose)))
  )
).pipe(
  Command.withDescription(
    "List the event types (MCP Events) your connections' servers offer, with the arguments each takes; poll one with `poll`"
  )
)

const decodeEventArguments = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObjectSchema))

export const pollCommand = Command.make(
  "poll",
  {
    alias: Argument.String("alias").pipe(
      Argument.withSchema(Alias),
      Argument.withDescription("The connection's alias, as `events` lists it")
    ),
    event: Argument.String("event").pipe(Argument.withDescription("The event type's name")),
    arguments: Flag.String("arguments").pipe(
      Flag.optional,
      Flag.withDescription("Subscription arguments as a JSON object, fitting the event type's inputSchema")
    ),
    cursor: Flag.String("cursor").pipe(
      Flag.optional,
      Flag.withDescription("The cursor the last poll returned; without it the poll starts from now")
    ),
    maxEvents: Flag.Int("max-events").pipe(Flag.optional, Flag.withDescription("Return at most this many")),
    maxAgeMs: Flag.Int("max-age-ms").pipe(
      Flag.optional,
      Flag.withDescription("Replay nothing older than this many milliseconds")
    ),
    verbose: verboseFlag()
  },
  ({ alias, event, arguments: given, cursor, maxEvents, maxAgeMs, verbose }) =>
    Effect.gen(function* () {
      const parsed = Option.isNone(given)
        ? undefined
        : yield* decodeEventArguments(given.value).pipe(
            Effect.mapError(() => cliError("--arguments must be a JSON object"))
          )
      const polled = yield* gatewayTask((client) =>
        client.delegated.pollEvents({
          payload: {
            alias,
            name: event,
            cursor: Option.getOrNull(cursor),
            ...whenPresent("arguments", parsed),
            ...whenPresent("maxEvents", Option.getOrUndefined(maxEvents)),
            ...whenPresent("maxAgeMs", Option.getOrUndefined(maxAgeMs))
          }
        })
      )
      yield* writeStdoutLine(jsonOutput(polled, verbose))
    })
).pipe(
  Command.withDescription(
    "Poll an event type once: what happened since --cursor (or nothing, from now), and the cursor to pass next time"
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
