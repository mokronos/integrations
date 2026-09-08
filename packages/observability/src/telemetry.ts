import { FetchHttpClient } from "effect/unstable/http"
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability"
import { Layer } from "effect"
import { whenPresent } from "@mokronos/contracts"

export const telemetryEndpointEnvVar = "INTEGRATIONS_OTLP_ENDPOINT"

export const telemetryAuthorizationEnvVar = "INTEGRATIONS_OTLP_AUTHORIZATION"

export interface TelemetryOptions {
  readonly serviceName: string
  readonly serviceVersion?: string | undefined
  readonly endpoint?: string | undefined
  readonly headers?: Record<string, string> | undefined
}

const trimOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

export const telemetryEndpointFromEnv = (): string | undefined =>
  trimOrUndefined(process.env[telemetryEndpointEnvVar])

export const telemetryAuthorizationFromEnv = (): string | undefined =>
  trimOrUndefined(process.env[telemetryAuthorizationEnvVar])

const resolveHeaders = (
  options: TelemetryOptions
): Record<string, string> | undefined => {
  const authorization =
    options.headers?.["authorization"] ?? telemetryAuthorizationFromEnv()
  const headers = {
    ...options.headers,
    ...whenPresent("authorization", authorization)
  }
  return Object.keys(headers).length === 0 ? undefined : headers
}

export const telemetryLayer = (options: TelemetryOptions): Layer.Layer<never> => {
  const endpoint = options.endpoint ?? telemetryEndpointFromEnv()
  const trimmed = endpoint?.replace(/\/+$/, "")
  if (trimmed === undefined || trimmed.length === 0) return Layer.empty
  const resource = {
    serviceName: options.serviceName,
    serviceVersion: options.serviceVersion
  }
  const headers = resolveHeaders(options)
  return Layer.merge(
    OtlpTracer.layer({ url: `${trimmed}/v1/traces`, resource, headers }),
    OtlpLogger.layer({ url: `${trimmed}/v1/logs`, resource, headers })
  ).pipe(
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer)
  )
}
