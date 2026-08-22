import { FetchHttpClient } from "effect/unstable/http"
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability"
import { Effect, Layer, ManagedRuntime, Option, Tracer } from "effect"

/** The spread form of "include this field only when the value is there", kept
 *  beside the telemetry code that uses it rather than reaching into wfkit. */
const whenPresent = <K extends string, V>(
  key: K,
  value: V | null | undefined
): { readonly [P in K]?: V } =>
  Option.match(Option.fromNullishOr(value), {
    onNone: () => ({}),
    onSome: (present) => {
      const field: { [P in K]?: V } = {}
      field[key] = present
      return field
    }
  })

/** The environment variable holding the OTLP/HTTP base URL an app exports to,
 *  e.g. motel's `http://127.0.0.1:27686`. Unset or blank means telemetry is
 *  off: every layer and tracer below degrades to a no-op so callers never
 *  branch on whether tracing is enabled. */
export const telemetryEndpointEnvVar = "WF_OTLP_ENDPOINT"

/** The environment variable holding the raw value of the `authorization`
 *  header sent on every export request, e.g. Grafana Cloud's
 *  `Basic <base64(instance-id:token)>`. Ignored when {@link TelemetryOptions.headers}
 *  already carries its own `authorization`. */
export const telemetryAuthorizationEnvVar = "WF_OTLP_AUTHORIZATION"

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
 *  Provide it at composition roots with `Layer.provideMerge` (or a plain
 *  merge), so the built tracer lands in the root environment: provided-only
 *  layers satisfy engine requirements but leave the outermost span on the
 *  no-op default tracer, which exports nothing. */
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

/** The slice of `Headers` (or anything shaped like it) trace propagation reads. */
export interface HeaderReader {
  readonly get: (name: string) => string | null | undefined
}

const traceParentPattern = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i

/** Extracts W3C `traceparent` into a parent span, so an incoming request joins
 *  the caller's trace. Returns `undefined` for absent or malformed headers —
 *  a bad header starts a fresh trace rather than failing the request. */
export const traceSpanFromHeaders = (
  headers: HeaderReader
): Tracer.ExternalSpan | undefined => {
  const raw = headers.get("traceparent")
  if (raw === null || raw === undefined) return undefined
  const match = traceParentPattern.exec(raw.trim())
  if (match === null) return undefined
  const version = match[1]
  const traceId = match[2]
  const spanId = match[3]
  const flags = match[4]
  if (version === undefined || traceId === undefined || spanId === undefined || flags === undefined) {
    return undefined
  }
  if (version === "ff" || /^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined
  return Tracer.externalSpan({
    traceId,
    spanId,
    sampled: (Number.parseInt(flags, 16) & 1) === 1
  })
}

/** Wraps one request/response cycle in a server span on top of any incoming
 *  trace context. The wrapped handler keeps its exact rejection behaviour:
 *  what it threw before, callers still catch. */
export interface RequestTracer {
  readonly run: (request: Request, handle: () => Promise<Response>) => Promise<Response>
  dispose(): Promise<void>
}

export interface RequestTracerOptions extends TelemetryOptions {
  /** Span name prefix; the full name is `` `${spanName} ${method} ${path}` ``. */
  readonly spanName?: string | undefined
}

/** Builds a per-request tracer for plain promise-based HTTP handlers, or
 *  `undefined` when no endpoint resolves — callers store that directly and
 *  skip wrapping entirely. Owns its own runtime so disposal flushes pending
 *  batches before process exit. */
export const createRequestTracer = async (
  options: RequestTracerOptions
): Promise<RequestTracer | undefined> => {
  const endpoint = options.endpoint ?? telemetryEndpointFromEnv()
  if (endpoint === undefined) return undefined
  const runtime = ManagedRuntime.make(telemetryLayer({ ...options, endpoint }))
  const spanName = options.spanName ?? "http.server"
  return {
    run: (request, handle) => runtime.runPromise(requestEffect(spanName, request, handle)),
    dispose: () => runtime.dispose()
  }
}

const requestEffect = (
  spanName: string,
  request: Request,
  handle: () => Promise<Response>
): Effect.Effect<Response, unknown> => {
  const url = new URL(request.url)
  const search = url.search
  const attributes = {
    "http.request.method": request.method,
    "url.path": url.pathname,
    "server.address": url.host,
    ...whenPresent("url.query", search.length > 0 ? search.slice(1) : undefined)
  }
  return Effect.gen(function* () {
    // The outcome is settled at the promise layer, before Effect sees it, so
    // the raw thrown value rides the failure channel unchanged — a handler
    // that rejected before tracing arrived still rejects identically after.
    const outcome = yield* Effect.promise(() => handle().then(
      (response) => ({ _tag: "responded" as const, response }),
      (cause) => ({ _tag: "thrown" as const, cause })
    ))
    if (outcome._tag === "thrown") {
      return yield* Effect.fail(outcome.cause)
    }
    return yield* Effect.succeed(outcome.response).pipe(
      Effect.tap((response) =>
        Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
      )
    )
  }).pipe(
    Effect.withSpan(`${spanName} ${request.method} ${url.pathname}`, {
      kind: "server",
      parent: traceSpanFromHeaders(request.headers),
      attributes
    })
  )
}
