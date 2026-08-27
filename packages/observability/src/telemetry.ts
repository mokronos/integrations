import { FetchHttpClient } from "effect/unstable/http"
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability"
import { Layer } from "effect"
import { whenPresent } from "@mokronos/contracts"

/** The environment variable holding the OTLP/HTTP base URL an app exports to,
 *  e.g. motel's `http://127.0.0.1:27686`. Unset or blank means telemetry is
 *  off and the exporter layer is empty. */
export const telemetryEndpointEnvVar = "INTEGRATIONS_OTLP_ENDPOINT"

/** The environment variable holding the raw value of the `authorization`
 *  header sent on every export request, e.g. Grafana Cloud's
 *  `Basic <base64(instance-id:token)>`. Ignored when {@link TelemetryOptions.headers}
 *  already carries its own `authorization`. */
export const telemetryAuthorizationEnvVar = "INTEGRATIONS_OTLP_AUTHORIZATION"

export interface TelemetryOptions {
  /** `service.name` reported with every span and log record. */
  readonly serviceName: string
  readonly serviceVersion?: string | undefined
  /** OTLP/HTTP base URL. Defaults to {@link telemetryEndpointEnvVar}; absent
   *  disables export entirely (no exporter is built). */
  readonly endpoint?: string | undefined
  /** Extra headers on every export request — how hosted endpoints authenticate
   *  (Grafana Cloud wants `authorization: Basic <base64(id:token)>`). Merged
   *  over {@link telemetryAuthorizationEnvVar}. */
  readonly headers?: Record<string, string> | undefined
}

const trimOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/** Runtimes without a Node-compatible `process` pass
 *  {@link TelemetryOptions.endpoint} / {@link TelemetryOptions.headers}
 *  explicitly from their bindings instead. */
export const telemetryEndpointFromEnv = (): string | undefined =>
  trimOrUndefined(process.env[telemetryEndpointEnvVar])

export const telemetryAuthorizationFromEnv = (): string | undefined =>
  trimOrUndefined(process.env[telemetryAuthorizationEnvVar])

/** Explicit option headers win; the env-provided authorization only fills a
 *  gap, so a caller can override it without unsetting the variable. */
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

/** The one telemetry layer: OTLP traces + logs over HTTP/JSON, off unless an
 *  endpoint resolves. Logs merge with whatever logger already exists, so
 *  console output survives when export turns on. Metrics are deliberately not
 *  exported — usage analytics is queries over spans and logs.
 *
 *  Provide it at the application composition root. Effect's HTTP middleware
 *  creates request spans, while named `Effect.fn` operations create the useful
 *  application spans within them. */
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
