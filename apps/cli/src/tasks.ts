import { Effect } from "effect"
import type { HttpClient } from "effect/http"
import { asGatewayError } from "@integragents/client"
import type { GatewayCallFailure, GatewayClient } from "@integragents/client"
import type { GatewayError } from "@integragents/contracts"
import { connectToGateway, IntegrationsCliError } from "./connection.ts"
import { connectToControlPlane, connectToOperatorGateway } from "./session.ts"
import type { ControlPlaneClient } from "./session.ts"

/** What a command can fail with: the gateway's own error, or the CLI's about its input and setup. */
export type CliFailure = GatewayError | IntegrationsCliError

export const asCliFailure = (failure: GatewayCallFailure | IntegrationsCliError): CliFailure =>
  failure instanceof IntegrationsCliError ? failure : asGatewayError(failure)

export const gatewayTask = <A, E extends GatewayCallFailure | IntegrationsCliError, R>(
  task: (client: GatewayClient) => Effect.Effect<A, E, R>
): Effect.Effect<A, CliFailure, R | HttpClient.HttpClient> =>
  connectToGateway().pipe(Effect.flatMap(task), Effect.mapError(asCliFailure))

export const operatorGatewayTask = <A, E extends GatewayCallFailure | IntegrationsCliError, R>(
  task: (client: GatewayClient) => Effect.Effect<A, E, R>
): Effect.Effect<A, CliFailure, R | HttpClient.HttpClient> =>
  connectToOperatorGateway().pipe(Effect.flatMap(task), Effect.mapError(asCliFailure))

export const controlPlaneTask = <A, E extends GatewayCallFailure | IntegrationsCliError>(
  task: (client: ControlPlaneClient) => Effect.Effect<A, E, HttpClient.HttpClient>
): Effect.Effect<A, CliFailure, HttpClient.HttpClient> =>
  connectToControlPlane().pipe(Effect.flatMap(task), Effect.mapError(asCliFailure))

export type GatewayTask = typeof gatewayTask
