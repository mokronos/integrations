import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug
} from "@executor-js/sdk/core"
import { runExecutor } from "./default-host.ts"
import type { ExecutorRunner } from "./host.ts"
import { ExecutorConnection } from "./schemas.ts"
import type { ExecutorIntegration } from "./schemas.ts"
import { Schema } from "effect"

const defaultExecutorRunner: ExecutorRunner = { run: runExecutor }

/** Creates a persisted credential-backed connection for an installed
 * integration. */
export const createExecutorConnection = async (options: {
  readonly integration: string
  readonly name: string
  readonly template: string
  readonly value?: string
  readonly values?: Readonly<Record<string, string>>
}, runner: ExecutorRunner = defaultExecutorRunner): Promise<ExecutorConnection> =>
  await runner.run((executor) => executor.connections.create({
    owner: "org",
    integration: IntegrationSlug.make(options.integration),
    name: ConnectionName.make(options.name),
    template: AuthTemplateSlug.make(options.template),
    ...(options.values === undefined
      ? { value: options.value ?? "" }
      : { values: { ...options.values } })
  })).then(Schema.decodeUnknownSync(ExecutorConnection))

export const listExecutorConnections = async (
  runner: ExecutorRunner = defaultExecutorRunner
): Promise<ReadonlyArray<ExecutorConnection>> =>
  await runner.run((executor) => executor.connections.list()).then((connections) =>
    Schema.decodeUnknownSync(Schema.Array(ExecutorConnection))(connections)
  )

export const removeExecutorConnection = async (options: {
  readonly integration: string
  readonly name: string
}, runner: ExecutorRunner = defaultExecutorRunner): Promise<void> =>
  await runner.run((executor) => executor.connections.remove({
    owner: "org",
    integration: IntegrationSlug.make(options.integration),
    name: ConnectionName.make(options.name)
  }))

/** Applies the default unauthenticated-connection policy. Authenticated
 * integrations are intentionally left untouched for an explicit auth flow. */
export const ensureExecutorConnection = async (
  integration: ExecutorIntegration,
  connectionName: string,
  runner: ExecutorRunner = defaultExecutorRunner
): Promise<boolean> => {
  const existing = (await listExecutorConnections(runner)).some((connection) =>
    connection.integration === integration.slug && connection.name === connectionName
  )
  if (existing) return true
  const noAuth = integration.authMethods.find((method) => method.kind === "none")
  if (noAuth === undefined && integration.authMethods.length > 0) return false
  await createExecutorConnection({
    integration: integration.slug,
    name: connectionName,
    template: noAuth?.template ?? "none",
    value: ""
  }, runner)
  return true
}

/** Persisted connection operations bound to an explicit host/runner. */
export const createExecutorConnections = (runner: ExecutorRunner) => ({
  create: (options: Parameters<typeof createExecutorConnection>[0]) =>
    createExecutorConnection(options, runner),
  list: () => listExecutorConnections(runner),
  remove: (options: Parameters<typeof removeExecutorConnection>[0]) =>
    removeExecutorConnection(options, runner),
  ensure: (integration: ExecutorIntegration, connectionName: string) =>
    ensureExecutorConnection(integration, connectionName, runner)
})

export type ExecutorConnections = ReturnType<typeof createExecutorConnections>
