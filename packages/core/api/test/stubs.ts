import { Context, Effect, Option } from "effect"
import { CatalogStore, IntegrationHost, McpHost, OAuthFlows, OpenApiInvoker, SpecCache } from "@mokronos/integrations"
import type { HostServices } from "@mokronos/integrations"
import type { IntegrationsApi } from "@mokronos/integrations"

/** Members a given test never reaches. Throwing is deliberate: a partial fake
 *  that returned `undefined` would let a handler quietly start depending on one
 *  of these and still pass. */
export const notStubbed = (member: string) => () => {
  throw new Error(`stubIntegrations: ${member} is not stubbed for these tests`)
}

/** A host that answers nothing. For tests about the gateway's own behaviour —
 *  authority, sessions, failure handling — where the host is only present
 *  because the handler seam requires one. */
export const stubIntegrations = (): IntegrationsApi => ({
  tools: {
    execute: notStubbed("tools.execute"),
    summaries: async () => [],
    describe: notStubbed("tools.describe"),
    list: async () => []
  },
  connections: {
    list: async () => [],
    remove: notStubbed("connections.remove"),
    create: notStubbed("connections.create"),
    ensure: notStubbed("connections.ensure")
  },
  catalog: {
    classify: notStubbed("catalog.classify"),
    list: notStubbed("catalog.list"),
    find: notStubbed("catalog.find"),
    addMcp: notStubbed("catalog.addMcp"),
    addOpenApi: notStubbed("catalog.addOpenApi"),
    rename: notStubbed("catalog.rename"),
    remove: notStubbed("catalog.remove")
  },
  auth: {
    probe: notStubbed("auth.probe"),
    registerClient: notStubbed("auth.registerClient"),
    createClient: notStubbed("auth.createClient"),
    start: notStubbed("auth.start"),
    complete: notStubbed("auth.complete")
  },
  provisioning: {
    install: notStubbed("provisioning.install"),
    provision: notStubbed("provisioning.provision")
  },
  validateIntegrationNode: notStubbed("validateIntegrationNode"),
  listIntegrationOverviews: async () => []
})

/** The host as the handlers now reach it: one Effect service instead of the
 *  four Promise sub-APIs. Members a given test never touches die rather than
 *  answering, for the same reason {@link notStubbed} throws — a fake that
 *  returned `[]` would let a handler start depending on it unnoticed. */
export const stubHost = (
  overrides: Partial<IntegrationHost["Service"]> = {}
): IntegrationHost["Service"] => ({
  listIntegrations: () => Effect.succeed([]),
  findIntegration: () => Effect.succeed(Option.none()),
  addMcp: dies("addMcp"),
  addOpenApi: dies("addOpenApi"),
  renameIntegration: dies("renameIntegration"),
  removeIntegration: dies("removeIntegration"),
  createConnection: dies("createConnection"),
  listConnections: () => Effect.succeed([]),
  removeConnection: dies("removeConnection"),
  refreshConnection: dies("refreshConnection"),
  toolSummaries: () => Effect.succeed([]),
  listTools: () => Effect.succeed([]),
  describeTool: dies("describeTool"),
  execute: dies("execute"),
  ...overrides
})

const dies = (member: string) => () =>
  Effect.die(new Error(`stubHost: ${member} is not stubbed for these tests`))

const catalogStore: CatalogStore["Service"] = {
  listIntegrations: dies("CatalogStore.listIntegrations"),
  findIntegration: dies("CatalogStore.findIntegration"),
  putIntegration: dies("CatalogStore.putIntegration"),
  renameIntegration: dies("CatalogStore.renameIntegration"),
  removeIntegration: dies("CatalogStore.removeIntegration"),
  listConnections: dies("CatalogStore.listConnections"),
  putConnection: dies("CatalogStore.putConnection"),
  removeConnection: dies("CatalogStore.removeConnection"),
  findOAuthClient: dies("CatalogStore.findOAuthClient"),
  putOAuthClient: dies("CatalogStore.putOAuthClient"),
  putOAuthFlow: dies("CatalogStore.putOAuthFlow"),
  takeOAuthFlow: dies("CatalogStore.takeOAuthFlow"),
  listTools: dies("CatalogStore.listTools"),
  findTool: dies("CatalogStore.findTool"),
  replaceTools: dies("CatalogStore.replaceTools"),
  findSpecDocument: dies("CatalogStore.findSpecDocument"),
  putSpecDocument: dies("CatalogStore.putSpecDocument")
}

/** The host's whole service context, as `createGatewayHandler` now takes it.
 *
 *  Only `IntegrationHost` is stubbed with behaviour: the rest are reachable
 *  solely from `/v1/integrations/discover`, and a test that exercises that route
 *  supplies its own. The others die rather than answering, so a handler that
 *  starts depending on one says so. */
export const stubHostContext = (
  overrides: Partial<IntegrationHost["Service"]> = {},
  /** Only `/v1/integrations/discover` reaches these, and it reaches both:
   *  classification tries an MCP handshake, then an OpenAPI parse. */
  reading: {
    readonly mcp?: Partial<McpHost["Service"]>
    readonly specs?: Partial<SpecCache["Service"]>
  } = {}
): Context.Context<HostServices> =>
  Context.empty().pipe(
    Context.add(IntegrationHost, stubHost(overrides)),
    Context.add(McpHost, {
      probe: dies("McpHost.probe"),
      listTools: dies("McpHost.listTools"),
      callTool: dies("McpHost.callTool"),
      ...reading.mcp
    }),
    Context.add(SpecCache, {
      load: dies("SpecCache.load"),
      compileUrl: dies("SpecCache.compileUrl"),
      ...reading.specs
    }),
    Context.add(OpenApiInvoker, { call: dies("OpenApiInvoker.call") }),
    Context.add(OAuthFlows, {
      probe: dies("OAuthFlows.probe"),
      registerDynamicClient: dies("OAuthFlows.registerDynamicClient"),
      createClient: dies("OAuthFlows.createClient"),
      start: dies("OAuthFlows.start"),
      complete: dies("OAuthFlows.complete"),
      accessToken: dies("OAuthFlows.accessToken")
    }),
    Context.add(CatalogStore, catalogStore)
  )
