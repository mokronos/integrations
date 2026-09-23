import { dirname } from "node:path"
import { Cause, Context, Effect, Exit, FileSystem, Layer, Option, Schema, Semaphore, Tracer } from "effect"
import { whenPresent } from "@mokronos/integrations-contracts"

const maxFileBytes = 10 * 1024 * 1024
const rotatedFiles = 5

const Attributes = Schema.Record(Schema.String, Schema.Json)

export const TraceEvent = Schema.Struct({
  name: Schema.String,
  time: Schema.String,
  attributes: Attributes
})
export type TraceEvent = typeof TraceEvent.Type

/** One finished span, as a line of the trace file. */
export const TraceRecord = Schema.Struct({
  service: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["internal", "server", "client", "producer", "consumer"]),
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optional(Schema.String),
  start: Schema.String,
  durationMs: Schema.Number,
  outcome: Schema.Literals(["success", "failure", "interrupted"]),
  cause: Schema.optional(Schema.String),
  attributes: Attributes,
  events: Schema.Array(TraceEvent)
})
export type TraceRecord = typeof TraceRecord.Type

const decodeJson = Schema.decodeUnknownOption(Schema.Json)

const jsonAttributes = (
  entries: Iterable<readonly [string, Parameters<Tracer.Span["attribute"]>[1]]>
): TraceRecord["attributes"] => {
  const attributes: Record<string, Schema.Json> = {}
  for (const [key, value] of entries) {
    if (value === undefined) continue
    attributes[key] = Option.getOrElse(decodeJson(value), () => String(value))
  }
  return attributes
}

const isoOf = (nanos: bigint): string => new Date(Number(nanos / 1_000_000n)).toISOString()

const outcomeOf = (exit: Parameters<Tracer.Span["end"]>[1]): Pick<TraceRecord, "outcome" | "cause"> =>
  Exit.isSuccess(exit)
    ? { outcome: "success" }
    : {
      outcome: Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failure",
      cause: Cause.pretty(exit.cause)
    }

/** Wraps a tracer so every sampled span it ends is also handed to `record`. */
export const recordingTracer = (
  delegate: Tracer.Tracer,
  service: string,
  record: (span: TraceRecord) => void
): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      const span = delegate.span(options)
      const events: Array<TraceEvent> = []
      return {
        _tag: "Span",
        name: span.name,
        spanId: span.spanId,
        traceId: span.traceId,
        parent: span.parent,
        annotations: span.annotations,
        sampled: span.sampled,
        kind: span.kind,
        get status() {
          return span.status
        },
        get attributes() {
          return span.attributes
        },
        get links() {
          return span.links
        },
        end(endTime, exit) {
          span.end(endTime, exit)
          if (!span.sampled) return
          record({
            service,
            name: span.name,
            kind: span.kind,
            traceId: span.traceId,
            spanId: span.spanId,
            ...whenPresent("parentSpanId", Option.getOrUndefined(span.parent)?.spanId),
            start: isoOf(options.startTime),
            durationMs: Number(endTime - options.startTime) / 1_000_000,
            ...outcomeOf(exit),
            attributes: jsonAttributes(span.attributes),
            events
          })
        },
        attribute(key, value) {
          span.attribute(key, value)
        },
        event(name, startTime, attributes) {
          events.push({
            name,
            time: isoOf(startTime),
            attributes: jsonAttributes(Object.entries(attributes ?? {}))
          })
          span.event(name, startTime, attributes)
        },
        addLinks(links) {
          span.addLinks(links)
        }
      }
    },
    ...whenPresent("context", delegate.context)
  })

const open = Effect.fnUntraced(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  const lock = yield* Semaphore.make(1)
  let pending: Array<string> = []

  const rotate = Effect.gen(function*() {
    yield* fs.remove(`${path}.${rotatedFiles}`, { force: true })
    for (let index = rotatedFiles - 1; index >= 1; index--) {
      if (yield* fs.exists(`${path}.${index}`)) {
        yield* fs.rename(`${path}.${index}`, `${path}.${index + 1}`)
      }
    }
    yield* fs.rename(path, `${path}.1`)
  })

  const flush = Effect.suspend(() => {
    if (pending.length === 0) return Effect.void
    const chunk = pending.join("")
    pending = []
    return Effect.gen(function*() {
      const size = yield* fs.stat(path).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.orElseSucceed(() => 0)
      )
      if (size > 0 && size + chunk.length > maxFileBytes) yield* rotate
      yield* fs.writeFileString(path, chunk, { flag: "a" })
    })
  }).pipe(
    lock.withPermit,
    Effect.catchCause((cause) => Effect.logWarning(`Could not write the trace file ${path}`, cause)),
    Effect.withTracerEnabled(false)
  )

  yield* fs.makeDirectory(dirname(path), { recursive: true }).pipe(Effect.ignore)
  yield* Effect.addFinalizer(() => flush)
  yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep("1 second"), flush)))

  return {
    record: (span: TraceRecord) => {
      pending.push(`${JSON.stringify(span)}\n`)
    },
    flush
  }
})

/**
 * An append-only NDJSON file of finished spans, written in batches and rotated
 * by size so it never outgrows `rotatedFiles` × 10 MiB.
 */
export class TraceFile extends Context.Service<TraceFile, {
  readonly record: (span: TraceRecord) => void
  readonly flush: Effect.Effect<void>
}>()("@mokronos/integrations-observability/TraceFile") {
  static readonly layer = (path: string): Layer.Layer<TraceFile, never, FileSystem.FileSystem> =>
    Layer.effect(TraceFile, open(path))
}
