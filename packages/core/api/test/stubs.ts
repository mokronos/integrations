import { Context, Effect, Option } from "effect"
import { CatalogStore, IntegrationHost, McpHost, OAuthFlows, OpenApiInvoker, SpecCache } from "@mokronos/integrations"
import type { HostServices } from "@mokronos/integrations"

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

export const catalogStoreFake = (
  overrides: Partial<CatalogStore["Service"]> = {}
): CatalogStore["Service"] => ({
  ...catalogStore,
  putConnection: () => Effect.void,
  ...overrides
})

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

export const stubHostContext = (
  overrides: Partial<IntegrationHost["Service"]> = {},
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
