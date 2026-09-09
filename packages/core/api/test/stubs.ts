import { Context, Effect, Option } from "effect"
import { CatalogStore, Integrations, McpClient, OAuthFlows, OpenApiInvoker, SpecCache } from "@integrations/integrations"
import type { IntegrationServices } from "@integrations/integrations"

export const stubIntegrations = (
  overrides: Partial<Integrations["Service"]> = {}
): Integrations["Service"] => ({
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
  Effect.die(new Error(`stubIntegrations: ${member} is not stubbed for these tests`))

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

export const stubIntegrationsContext = (
  overrides: Partial<Integrations["Service"]> = {},
  reading: {
    readonly mcp?: Partial<McpClient["Service"]>
    readonly specs?: Partial<SpecCache["Service"]>
  } = {}
): Context.Context<IntegrationServices> =>
  Context.empty().pipe(
    Context.add(Integrations, stubIntegrations(overrides)),
    Context.add(McpClient, {
      probe: dies("McpClient.probe"),
      listTools: dies("McpClient.listTools"),
      callTool: dies("McpClient.callTool"),
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
