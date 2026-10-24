import { DateTime, Duration, Effect, Option } from "effect"
import {
  asJson,
  connectionResourceUri,
  declaredUi,
  describeError,
  Forbidden,
  isDelegationTemplate,
  NotFound,
  ToolName,
  whenPresent
} from "@integragents/contracts"
import type {
  Alias,
  AppContext,
  AppSession,
  AppSessionId,
  AppSessionNotes,
  InvocationOutcome,
  Json,
  Profile,
  ResourceContents,
  ToolUi
} from "@integragents/contracts"
import { Integrations } from "@integragents/integrations"
import {
  boundToolAddress,
  GatewayStoreService,
  invokeAsProfile,
  listEffectiveTools,
  newAppSessionId
} from "@integragents/gateway-core"
import type { CallOrigin } from "@integragents/gateway-core"
import { outcomeResult } from "./mcp-results.ts"
import { capture } from "./observability.ts"
import { invokeDependencies } from "./operations.ts"
import { connectionsOf, readProfileResource } from "./resources.ts"
import { GatewayConfig } from "./services.ts"

/**
 * A caller with no MCP host of its own, such as the `i` CLI, still gets the
 * MCP App a tool's result renders in: the gateway keeps the call as an app
 * session and hands back a dashboard link. Only a person signed in to the
 * dashboard opens it; calls the view makes run as the profile that made the
 * original call, under its decisions, and are attributed to that person.
 */

const appSessionLifetime = Duration.hours(24)

/** The tool's MCP App as this profile reaches it; nothing for a tool without one. */
const toolUiFor = (profile: Profile, alias: Alias, tool: ToolName) =>
  Effect.gen(function* () {
    const store = yield* GatewayStoreService
    const integrations = yield* Integrations
    const enabled = yield* capture(listEffectiveTools(store, profile.id))
    const entry = enabled.find((candidate) => candidate.alias === alias && candidate.tool === tool)
    if (entry === undefined || isDelegationTemplate(entry.connection)) return undefined
    const described = yield* integrations.describeTool(boundToolAddress(entry.connection, tool)).pipe(Effect.option)
    const declared = declaredUi(Option.getOrUndefined(described)?.meta)
    return declared === undefined
      ? undefined
      : { ...declared, resourceUri: connectionResourceUri(alias, declared.resourceUri) }
  })

const pageUrl = (id: AppSessionId) =>
  Effect.map(GatewayConfig, (config) => {
    const origin = config.dashboardUrl?.()
    return origin === undefined ? undefined : `${origin.replace(/\/+$/, "")}/apps/${encodeURIComponent(id)}`
  })

/** A succeeded call to a tool with an MCP App comes back with a link a person opens to see it. */
export const withAppSession = (
  profile: Profile,
  origin: CallOrigin,
  call: { readonly alias: Alias; readonly tool: ToolName; readonly arguments: Json },
  outcome: InvocationOutcome
) =>
  Effect.gen(function* () {
    if (outcome.status !== "succeeded") return outcome
    const ui: ToolUi | undefined = yield* toolUiFor(profile, call.alias, call.tool)
    if (ui === undefined) return outcome
    const store = yield* GatewayStoreService
    const id = yield* newAppSessionId
    const result = yield* outcomeResult(call.alias, outcome)
    const expiresAt = DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, appSessionLifetime))
    yield* capture(
      store.createAppSession({
        id,
        tenantId: profile.tenantId,
        profileId: profile.id,
        caller: origin.caller,
        alias: call.alias,
        tool: call.tool,
        arguments: call.arguments,
        result: asJson(result),
        resourceUri: ui.resourceUri,
        expiresAt
      })
    )
    const url = yield* pageUrl(id)
    return { ...outcome, app: { session: id, resourceUri: ui.resourceUri, ...whenPresent("url", url) } }
  })

/** A session of the tenant asking, with the profile it runs as. */
const sessionIn = (tenantId: Profile["tenantId"], id: AppSessionId) =>
  Effect.gen(function* () {
    const store = yield* GatewayStoreService
    const found = yield* capture(store.getAppSession(tenantId, id))
    if (found === undefined) return yield* new NotFound({ resource: "app-session", id })
    const profile = yield* capture(store.findProfileById(tenantId, found.session.profileId))
    if (profile === undefined || profile.revokedAt !== null) {
      return yield* new NotFound({ resource: "app-session", id })
    }
    return { ...found, profile }
  })

export const readAppSession = (tenantId: Profile["tenantId"], id: AppSessionId) =>
  Effect.map(sessionIn(tenantId, id), (found): AppSession => found.session)

const errorResult = (text: string) => ({ content: [{ type: "text", text }], isError: true })

/** What a call the view made answers with, in the shape MCP gives the view: never an exception. */
const viewResult = (alias: Alias, outcome: InvocationOutcome) => {
  switch (outcome.status) {
    case "invalid":
      return Effect.succeed(asJson(errorResult(describeError(outcome.error))))
    case "input-required":
      return Effect.succeed(
        asJson(errorResult("The tool asked for input the dashboard cannot relay; call it from the agent instead."))
      )
    case "failed":
      return outcome.error === undefined
        ? Effect.map(outcomeResult(alias, outcome), asJson)
        : Effect.succeed(asJson(errorResult(describeError(outcome.error))))
    default:
      return Effect.map(outcomeResult(alias, outcome), asJson)
  }
}

/**
 * A tool call the view made, run as the session's profile. A view reaches only
 * the connection its own tool is on, and only tools its server lets views call.
 */
export const callFromApp = (
  tenantId: Profile["tenantId"],
  id: AppSessionId,
  person: string,
  call: { readonly name: string; readonly arguments: Json }
) =>
  Effect.gen(function* () {
    const { session, caller, profile } = yield* sessionIn(tenantId, id)
    const tool = ToolName.make(call.name)
    const ui = yield* toolUiFor(profile, session.alias, tool)
    if (ui?.visibility !== undefined && !ui.visibility.includes("app")) {
      return yield* new Forbidden({ code: "not-permitted" })
    }
    const origin: CallOrigin = {
      caller: { ...caller, agent: `${caller.agent ?? "agent"} via its MCP App, opened by ${person}` },
      authorizedBy: null
    }
    const outcome = yield* capture(
      invokeAsProfile(yield* invokeDependencies, {
        profile,
        origin,
        alias: session.alias,
        tool,
        arguments: call.arguments
      })
    )
    return yield* viewResult(session.alias, outcome)
  })

/** A resource the view read: a blob the gateway keeps, or what its own connection's server serves. */
export const readFromApp = (tenantId: Profile["tenantId"], id: AppSessionId, uri: string) =>
  Effect.gen(function* () {
    const { session, profile } = yield* sessionIn(tenantId, id)
    const store = yield* GatewayStoreService
    const integrations = yield* Integrations
    const effective = yield* capture(listEffectiveTools(store, profile.id, { integrations }))
    const own = connectionsOf(effective).filter((connection) => connection.alias === session.alias)
    const contents: ReadonlyArray<ResourceContents> = yield* readProfileResource(own, uri)
    return contents
  })

export const updateAppContext = (tenantId: Profile["tenantId"], id: AppSessionId, context: AppContext) =>
  Effect.gen(function* () {
    yield* sessionIn(tenantId, id)
    const store = yield* GatewayStoreService
    yield* capture(store.setAppContext(tenantId, id, context))
  })

export const sendAppMessage = (tenantId: Profile["tenantId"], id: AppSessionId, content: ReadonlyArray<Json>) =>
  Effect.gen(function* () {
    yield* sessionIn(tenantId, id)
    const store = yield* GatewayStoreService
    const sentAt = DateTime.toDateUtc(yield* DateTime.now)
    yield* capture(store.addAppMessage(tenantId, id, { role: "user", content: [...content], sentAt }))
  })

/** What the view told the agent, for the profile that made the call. */
export const appSessionNotes = (profile: Profile, id: AppSessionId) =>
  Effect.gen(function* () {
    const store = yield* GatewayStoreService
    const found = yield* capture(store.getAppSession(profile.tenantId, id))
    if (found === undefined || found.session.profileId !== profile.id) {
      return yield* new NotFound({ resource: "app-session", id })
    }
    const notes: AppSessionNotes = {
      session: id,
      context: found.session.context,
      messages: found.session.messages
    }
    return notes
  })
