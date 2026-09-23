import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { makeTelemetry, TraceRecord } from "@integragents/observability"

const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(TraceRecord))

const readRecords = (path: string) =>
  Effect.promise(() => readFile(path, "utf8")).pipe(
    Effect.map((text) => text.trim().split("\n").map((line) => decodeRecord(line)))
  )

const recordNamed = (records: ReadonlyArray<TraceRecord>, name: string): TraceRecord => {
  const record = records.find((candidate) => candidate.name === name)
  if (record === undefined) throw new Error(`no span named ${name}`)
  return record
}

describe("telemetry", () => {
  it.effect("writes finished spans, their logs, and their failures to the trace file", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "telemetry-")))
      const path = join(directory, "logs", "test.trace.ndjson")

      yield* Effect.scoped(Effect.gen(function*() {
        const telemetry = yield* makeTelemetry({
          serviceName: "telemetry-test",
          serviceVersion: "0.0.0",
          console: "stderr",
          traceFile: path
        })
        yield* Effect.logInfo("inside the child").pipe(
          Effect.withSpan("Test.child", { attributes: { "tool.name": "search" } }),
          Effect.withSpan("Test.parent"),
          Effect.provide(telemetry.layer)
        )
        yield* Effect.fail("upstream refused").pipe(
          Effect.withSpan("Test.failing"),
          Effect.ignore,
          Effect.provide(telemetry.layer)
        )
      })).pipe(Effect.provide(BunFileSystem.layer))

      const records = yield* readRecords(path)
      const parent = recordNamed(records, "Test.parent")
      const child = recordNamed(records, "Test.child")
      const failing = recordNamed(records, "Test.failing")

      expect(child).toMatchObject({
        service: "telemetry-test",
        traceId: parent.traceId,
        parentSpanId: parent.spanId,
        outcome: "success",
        attributes: { "tool.name": "search" }
      })
      expect(child.events.map((event) => event.name)).toEqual(["inside the child"])
      expect(failing.outcome).toBe("failure")
      expect(failing.cause).toContain("upstream refused")
    }))

  it.effect("exports spans and logs over OTLP when the OTEL variables ask for it", () =>
    Effect.gen(function*() {
      const received: Array<{ readonly path: string; readonly body: string }> = []
      const collector = Bun.serve({
        port: 0,
        fetch: async (request) => {
          received.push({ path: new URL(request.url).pathname, body: await request.text() })
          return new Response(null, { status: 200 })
        }
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => collector.stop(true)))

      yield* Effect.scoped(Effect.gen(function*() {
        const telemetry = yield* makeTelemetry({
          serviceName: "telemetry-test",
          serviceVersion: "0.0.0",
          console: "stderr"
        })
        yield* Effect.logWarning("exported warning").pipe(
          Effect.withSpan("Test.exported"),
          Effect.provide(telemetry.layer)
        )
      })).pipe(
        Effect.provide(Layer.merge(BunFileSystem.layer, ConfigProvider.layer(ConfigProvider.fromEnv({
          env: {
            OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
            OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
            OTEL_TRACES_EXPORTER: "otlp",
            OTEL_LOGS_EXPORTER: "otlp"
          }
        }))))
      )

      const bodyAt = (path: string) => received.filter((request) => request.path === path).map((request) => request.body).join("")
      expect(bodyAt("/v1/traces")).toContain("Test.exported")
      expect(bodyAt("/v1/logs")).toContain("exported warning")
    }).pipe(Effect.scoped))
})
