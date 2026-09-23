import { FetchHttpClient } from "effect/unstable/http"
import {
  OtlpExporter,
  OtlpLogger,
  OtlpMetrics,
  OtlpSerialization,
  OtlpTracer
} from "effect/unstable/observability"
import { Config, Context, Effect, FileSystem, Layer, Logger, Option, References, Tracer } from "effect"
import type { Scope } from "effect"
import { recordingTracer, TraceFile } from "./trace-file.ts"

export const logLevelEnvVar = "INTEGRATIONS_LOG_LEVEL"

/** The variables that configure telemetry, so a host can carry them into a service it installs. */
export const isTelemetryEnvVar = (name: string): boolean =>
  name === logLevelEnvVar || name.startsWith("OTEL_")

const settings = Config.all({
  logLevel: Config.logLevel(logLevelEnvVar).pipe(Config.withDefault("Info" as const)),
  protocol: Config.literals(["http/protobuf", "http/json"], "OTEL_EXPORTER_OTLP_PROTOCOL").pipe(
    Config.withDefault("http/protobuf" as const)
  )
})

export interface TelemetryOptions {
  readonly serviceName: string
  readonly serviceVersion: string
  /** `leveled` sends warnings and errors to stderr and the rest to stdout; `stderr` keeps stdout for program output. */
  readonly console: "leveled" | "stderr"
  /** An NDJSON file every finished span is appended to. */
  readonly traceFile?: string | undefined
}

export interface Telemetry {
  /** This process's tracer, loggers, and log level, for any runtime that should report through them. */
  readonly layer: Layer.Layer<never>
  /** Writes out whatever spans and logs are still buffered. */
  readonly flush: Effect.Effect<void>
}

/**
 * Logs go to the console and, as span events, into the trace. Spans go to the
 * trace file when one is given, and every signal goes over OTLP when the
 * standard `OTEL_*` variables ask for it (`OTEL_EXPORTER_OTLP_ENDPOINT` plus
 * `OTEL_TRACES_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=otlp`).
 */
export const makeTelemetry = Effect.fnUntraced(function*(
  options: TelemetryOptions
): Effect.fn.Return<Telemetry, never, FileSystem.FileSystem | Scope.Scope> {
  const { logLevel, protocol } = yield* Effect.orDie(settings)
  const resource = { serviceName: options.serviceName, serviceVersion: options.serviceVersion }
  const console = options.console === "stderr"
    ? Logger.withConsoleError(Logger.formatLogFmt)
    : Logger.withLeveledConsole(Logger.formatLogFmt)

  const built = yield* Layer.build(
    Layer.mergeAll(
      OtlpTracer.layerFromConfig({ resource }),
      OtlpLogger.layerFromConfig({ resource, mergeWithExisting: true }),
      OtlpMetrics.layerFromConfig({ resource }),
      options.traceFile === undefined ? Layer.empty : TraceFile.layer(options.traceFile)
    ).pipe(
      Layer.provide(protocol === "http/json" ? OtlpSerialization.layerJson : OtlpSerialization.layerProtobuf),
      Layer.provide(FetchHttpClient.layer),
      Layer.provideMerge(Logger.layer([console, Logger.tracerLogger]))
    )
  )

  const traceFile = Context.getOption(built, TraceFile)
  const exporting = Context.get(built, Tracer.Tracer)
  const tracer = Option.match(traceFile, {
    onNone: () => exporting,
    onSome: (file) => recordingTracer(exporting, options.serviceName, file.record)
  })

  return {
    layer: Layer.succeedContext(built.pipe(
      Context.add(Tracer.Tracer, tracer),
      Context.add(References.MinimumLogLevel, logLevel)
    )),
    flush: Effect.andThen(
      Context.get(built, OtlpExporter.Flusher).flush,
      Option.match(traceFile, { onNone: () => Effect.void, onSome: (file) => file.flush })
    )
  }
})

/** Telemetry for a process with a single runtime, such as one CLI invocation. */
export const telemetryLayer = (options: TelemetryOptions): Layer.Layer<never, never, FileSystem.FileSystem> =>
  Layer.unwrap(Effect.map(makeTelemetry(options), (telemetry) => telemetry.layer))
