import { mkdirSync } from "node:fs"
import path from "node:path"
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { BunHttpClient } from "@effect/platform-bun"
import { LibsqlClient } from "@effect/sql-libsql"
import { Context, Effect, Layer, ManagedRuntime, Predicate, Schema } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { SqlClient } from "effect/unstable/sql"
import { webCryptoLayer, whenPresent } from "@integrations/contracts"
import {
  Alias,
  ClientId,
  defaultTenantId,
  GatewayStoreService,
  invokeAsClient,
  listEffectiveTools,
  newClientId,
  reconcileConfigurations,
  resolveEncryption,
  SubjectId,
  ToolName
} from "@integrations/gateway-core"
import { gatewayCoreLayer } from "@integrations/gateway-api"
import type { GatewayCoreServices } from "@integrations/gateway-api"
import { ConnectionName, IntegrationSlug } from "@integrations/contracts"
import { OAuthFlowSessions } from "@integrations/gateway-api"
import { AuthTemplateSlug, Integrations } from "@integrations/integrations"
import { page } from "./page.ts"
import type { AgentView, PageModel } from "./page.ts"

const dataDirectory = path.resolve(import.meta.dirname, "..", "data")
mkdirSync(dataDirectory, { recursive: true })

// The platform opens its database and runs its own migrations, which carry the
// gateway's tables as well. The gateway then joins the same connection.
const database = createClient({ url: `file:${path.join(dataDirectory, "platform.sqlite")}` })
await database.execute("PRAGMA foreign_keys = ON")
await migrate(drizzle(database), { migrationsFolder: path.resolve(import.meta.dirname, "..", "drizzle") })

const encryption = await resolveEncryption({
  ...whenPresent("envValue", process.env["INTEGRATIONS_MASTER_KEY"]),
  keyFile: path.join(dataDirectory, "master.key")
})

const runtime = ManagedRuntime.make(
  gatewayCoreLayer({ encryption, blobDirectory: dataDirectory, migrate: false }).pipe(
    Layer.provideMerge(Layer.mergeAll(
      LibsqlClient.layer({ liveClient: database }).pipe(Layer.provide(Reactivity.layer)),
      BunHttpClient.layer,
      webCryptoLayer
    ))
  )
)

const AgentRow = Schema.Struct({ id: Schema.String, name: Schema.String, gateway_client_id: ClientId })
const decodeAgents = Schema.decodeUnknownEffect(Schema.Array(AgentRow))
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const tenantId = defaultTenantId

const listAgents = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* decodeAgents(yield* sql.unsafe("SELECT id, name, gateway_client_id FROM agent ORDER BY name"))
})

/** One gateway client per agent: the platform keeps the id, the gateway keeps the policy. */
const createAgent = Effect.fn("Platform.createAgent")(function*(name: string) {
  const sql = yield* SqlClient.SqlClient
  const store = yield* GatewayStoreService
  const accessProfile = yield* store.findDefaultAccessProfile(tenantId)
  const approvalPolicy = yield* store.findDefaultApprovalPolicy(tenantId)
  if (accessProfile === undefined || approvalPolicy === undefined) {
    return yield* Effect.die(new Error("The tenant has no default access profile or approval policy"))
  }
  const client = yield* store.createClient({
    id: yield* newClientId,
    tenantId,
    accessProfileId: accessProfile.id,
    approvalPolicyId: approvalPolicy.id,
    name,
    capabilities: []
  })
  yield* sql.unsafe(
    "INSERT INTO agent (id, name, tenant_id, gateway_client_id) VALUES (?, ?, ?, ?)",
    [crypto.randomUUID(), name, tenantId, client.id]
  )
})

/** An OpenAPI service connected under one of its auth templates and granted to the default policy. */
const addIntegration = Effect.fn("Platform.addIntegration")(function*(input: {
  readonly spec: string
  readonly slug: string
  readonly template: string
  readonly token: string
}) {
  const store = yield* GatewayStoreService
  const integrations = yield* Integrations
  const integration = IntegrationSlug.make(input.slug)
  yield* integrations.addOpenApi({ spec: input.spec, slug: integration })
  yield* integrations.createConnection({
    owner: "org",
    integration,
    name: ConnectionName.make("default"),
    template: AuthTemplateSlug.make(input.template === "" ? "none" : input.template),
    ...whenPresent("value", input.token === "" ? undefined : input.token)
  })
  yield* reconcileConfigurations({ store, integrations, tenantId })
})

/**
 * Marks a tool as acting for the calling user: the grant names a user-owned
 * connection with no subject, and each invocation supplies the subject.
 */
const delegateTool = Effect.fn("Platform.delegateTool")(function*(input: {
  readonly integration: string
  readonly connection: string
  readonly tool: string
}) {
  const store = yield* GatewayStoreService
  const integrations = yield* Integrations
  const accessProfile = yield* store.findDefaultAccessProfile(tenantId)
  if (accessProfile === undefined) return yield* Effect.die(new Error("The tenant has no default access profile"))
  const existing = yield* store.listAccessProfileTools(accessProfile.id)
  yield* store.replaceAccessProfileTools(accessProfile.id, [...existing, {
    connection: { owner: "user", integration: IntegrationSlug.make(input.integration), name: ConnectionName.make(input.connection) },
    tool: ToolName.make(input.tool)
  }])
  yield* reconcileConfigurations({ store, integrations, tenantId })
})

/** The platform mirrors its users as gateway subjects; here a subject is whatever the form says. */
const ensureSubject = Effect.fn("Platform.ensureSubject")(function*(subject: SubjectId) {
  const store = yield* GatewayStoreService
  if ((yield* store.findSubjectById(subject)) === undefined) {
    yield* store.createSubject({ id: subject, tenantId })
  }
})

const agentView = Effect.fn("Platform.agentView")(function*(row: typeof AgentRow.Type, withSchemas: boolean) {
  const store = yield* GatewayStoreService
  const integrations = yield* Integrations
  const tools = yield* listEffectiveTools(store, row.gateway_client_id, { schemas: withSchemas, integrations })
  return { id: row.id, name: row.name, clientId: row.gateway_client_id, tools } satisfies AgentView
})

const execute = Effect.fn("Platform.execute")(function*(input: {
  readonly agentId: string
  readonly alias: string
  readonly tool: string
  readonly argumentsText: string
  readonly subject: string
}) {
  const store = yield* GatewayStoreService
  const integrations = yield* Integrations
  const oauth = yield* OAuthFlowSessions
  const { agentId, alias, tool, argumentsText } = input
  const subject = input.subject === "" ? undefined : SubjectId.make(input.subject)
  if (subject !== undefined) yield* ensureSubject(subject)
  const agents = yield* listAgents
  const row = agents.find((candidate) => candidate.id === agentId)
  if (row === undefined) return yield* Effect.die(new Error(`Unknown agent ${agentId}`))
  const client = yield* store.findClientById(tenantId, row.gateway_client_id)
  if (client === undefined) return yield* Effect.die(new Error(`Agent ${row.name} has no gateway client`))
  return yield* invokeAsClient({ store, integrations, oauth }, {
    client,
    alias: Alias.make(alias),
    tool: ToolName.make(tool),
    arguments: yield* decodeJson(argumentsText.trim() === "" ? "{}" : argumentsText),
    ...whenPresent("subject", subject)
  })
})

const render = Effect.fn("Platform.render")(function*(selected: string | undefined, result: PageModel["result"]) {
  const agents = yield* listAgents
  const integrations = yield* Integrations
  const catalog = yield* integrations.listIntegrations()
  const views = yield* Effect.forEach(agents, (row) => agentView(row, row.id === selected))
  return page({ agents: views, selected, integrations: catalog.map((entry) => entry.slug), result })
})

const field = (form: FormData, name: string): string => {
  const value = form.get(name)
  return Predicate.isString(value) ? value : ""
}

const handle = Effect.fn("Platform.handle")(function*(request: Request) {
  const url = new URL(request.url)
  const selected = url.searchParams.get("agent") ?? undefined
  if (request.method === "GET") return new Response(yield* render(selected, undefined), { headers: { "content-type": "text/html" } })

  const form = yield* Effect.promise(() => request.formData())
  if (url.pathname === "/agents") {
    yield* createAgent(field(form, "name"))
    return Response.redirect("/", 303)
  }
  if (url.pathname === "/integrations") {
    yield* addIntegration({
      spec: field(form, "spec"),
      slug: field(form, "slug"),
      template: field(form, "template"),
      token: field(form, "token")
    })
    return Response.redirect(selected === undefined ? "/" : `/?agent=${encodeURIComponent(selected)}`, 303)
  }
  if (url.pathname === "/delegate") {
    yield* delegateTool({
      integration: field(form, "integration"),
      connection: field(form, "connection"),
      tool: field(form, "tool")
    })
    return Response.redirect("/", 303)
  }
  if (url.pathname === "/execute") {
    const agentId = field(form, "agent")
    const outcome = yield* execute({
      agentId,
      alias: field(form, "alias"),
      tool: field(form, "tool"),
      argumentsText: field(form, "arguments"),
      subject: field(form, "subject")
    })
    return new Response(yield* render(agentId, outcome), { headers: { "content-type": "text/html" } })
  }
  return new Response("Not found", { status: 404 })
})

const services: Context.Context<GatewayCoreServices | SqlClient.SqlClient> =
  await runtime.runPromise(Effect.context<GatewayCoreServices | SqlClient.SqlClient>())

const server = Bun.serve({
  port: Number(process.env["PORT"] ?? 4100),
  fetch: (request) =>
    runtime.runPromise(handle(request).pipe(
      Effect.catchTag("InvalidInputError", (failure) => Effect.succeed(new Response(failure.message, { status: 400 }))),
      Effect.provide(services),
      Effect.catchCause((cause) => Effect.succeed(new Response(String(cause), { status: 500 })))
    ))
})

console.log(`platform demo at ${server.url}`)

const stop = async (): Promise<void> => {
  server.stop(true)
  await runtime.dispose()
  database.close()
}
process.once("SIGINT", () => void stop())
process.once("SIGTERM", () => void stop())
