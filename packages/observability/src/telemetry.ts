import { FetchHttpClient } from "effect/unstable/http"
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability"
import { Config, Effect, Layer, Option } from "effect"
import { optionalText, whenPresent } from "@mokronos/contracts"

export const telemetryEndpointEnvVar = "INTEGRATIONS_OTLP_ENDPOINT"

export const telemetryAuthorizationEnvVar = "INTEGRATIONS_OTLP_AUTHORIZATION"

export const telemetryEndpoint: Config.Config<Option.Option<string>> =
  optionalText(telemetryEndpointEnvVar)

export const telemetryAuthorization: Config.Config<Option.Option<string>> =
  optionalText(telemetryAuthorizationEnvVar)

export interface TelemetryOptions {
  readonly serviceName: string
  readonly serviceVersion?: string | undefined
  readonly endpoint?: string | undefined
  readonly headers?: Record<string, string> | undefined
}

export const telemetryLayer = (options: TelemetryOptions): Layer.Layer<never> =>
  Layer.unwrap(Effect.gen(function*() {
    const endpoint = options.endpoint ?? Option.getOrUndefined(yield* telemetryEndpoint)
    const trimmed = endpoint?.replace(/\/+$/, "")
    if (trimmed === undefined || trimmed.length === 0) return Layer.empty

    const authorization = options.headers?.["authorization"] ??
      Option.getOrUndefined(yield* telemetryAuthorization)
    const headers = {
      ...options.headers,
      ...whenPresent("authorization", authorization)
    }
    const resource = {
      serviceName: options.serviceName,
      serviceVersion: options.serviceVersion
    }
    return Layer.merge(
      OtlpTracer.layer({
        url: `${trimmed}/v1/traces`,
        resource,
        ...whenTelemetryHeaders(headers)
      }),
      OtlpLogger.layer({
        url: `${trimmed}/v1/logs`,
        resource,
        ...whenTelemetryHeaders(headers)
      })
    ).pipe(
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(FetchHttpClient.layer)
    )
  }).pipe(Effect.orDie))

const whenTelemetryHeaders = (
  headers: Record<string, string>
): { readonly headers?: Record<string, string> } =>
  Object.keys(headers).length === 0 ? {} : { headers }
