# @mokronos/integrations-observability

Tracing and logging for the gateway and the CLIs.

- **Spans** are always appended to a local NDJSON trace file, one finished span per line.
- **Logs** go to the console. Any log emitted inside a span is also stored on that span as an event, so it lands in the trace file with the span's `traceId`.
- **OTLP export** of traces, logs and metrics is switched on with the standard `OTEL_*` variables.

## Where things land

| What | Where |
| --- | --- |
| Gateway spans (`ii serve`, detached or installed) | `$INTEGRATIONS_HOME/logs/gateway.trace.ndjson` |
| CLI spans (`i`, `ii`) | `$INTEGRATIONS_HOME/logs/cli.trace.ndjson` |
| Gateway console output of a detached or installed gateway | `$INTEGRATIONS_HOME/logs/integrations.log` (info), `integrations.error.log` (warnings and errors) |
| Cloudflare Worker | Workers Logs, plus OTLP when configured |

`$INTEGRATIONS_HOME` defaults to `~/.integrations`.

Trace files rotate at 10 MiB and five older files are kept (`.1` … `.5`). The CLI sends `traceparent` headers to the gateway, so one command is one trace across both files. The gateway in turn sends `traceparent` to upstream OpenAPI and MCP servers.

When a request fails with a 500, the response is a `GatewayFailure` carrying that request's `traceId`. The CLI prints it as `(trace <id>)`, and the dashboard shows it in the error toast.

## Record shape

`TraceRecord` in `src/trace-file.ts` is the schema. Its fields:

- `service`, `name`, `kind`
- `traceId`, `spanId`, `parentSpanId`
- `start`, `durationMs`
- `outcome`: `success`, `failure` or `interrupted`
- `cause`: the pretty-printed Effect cause, when the span failed
- `attributes`
- `events`: logs, with `attributes["effect.logLevel"]`

## Reading traces

```sh
cd ~/.integrations/logs

# Everything one request or command did, across CLI and gateway
jq -c --arg t <traceId> 'select(.traceId == $t) | {service, name, durationMs, outcome}' *.trace.ndjson

# Why it failed
jq -r --arg t <traceId> 'select(.traceId == $t and .outcome == "failure") | .name + "\n" + .cause' gateway.trace.ndjson

# Recent failures of any kind
jq -c 'select(.outcome == "failure") | {start, name, traceId, cause: .cause[0:200]}' gateway.trace.ndjson | tail

# Warnings and errors logged inside spans
jq -c '.events[] | select(.attributes["effect.logLevel"] | IN("WARN", "ERROR")) | {time, name}' gateway.trace.ndjson | tail

# Requests the gateway refused (domain failures are logged at INFO with their tag)
jq -c 'select(.name | startswith("http.server")) | select(.events | length > 0) | {route: .attributes["http.route"], event: .events[0].name}' gateway.trace.ndjson | tail

# Slowest spans
jq -s -c 'sort_by(-.durationMs) | .[0:10][] | {name, durationMs, traceId}' gateway.trace.ndjson

# Tool invocations with their policy decision and outcome
jq -c 'select(.name == "Invocation.settle") | .attributes' gateway.trace.ndjson | tail
```

## Configuration

| Variable | Effect |
| --- | --- |
| `INTEGRATIONS_LOG_LEVEL` | Minimum level for console logs and span events (`Debug`, `Info` (default), `Warn`, `Error`, …) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL of an OTLP/HTTP collector; `/v1/traces`, `/v1/logs`, `/v1/metrics` are appended |
| `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER` | Must include `otlp` for that signal to be exported |
| `OTEL_EXPORTER_OTLP_HEADERS` | Headers for the collector, e.g. `authorization=Bearer%20…` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` (default) or `http/json` |
| `OTEL_SDK_DISABLED` | `true` turns OTLP export off |

`ii install` copies these variables from the installing shell into the systemd unit or launchd plist. After changing them, run `ii install` again.

### A local trace viewer

```sh
docker run --rm -p 3000:3000 -p 4318:4318 grafana/otel-lgtm

OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_TRACES_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp \
  bun run ii serve
```

Grafana is then at <http://localhost:3000>: Tempo has the traces and Loki the logs. The trace file is still written either way.

## Adding spans and logs

- **Name spans `Service.method`**, e.g. `Invocation.settle` or `GatewayStore.listClients`, with `Effect.fn("Service.method")`. HTTP spans are named by Effect (`http.server POST`, `http.client GET`).
- **Put spans at boundaries**, not around every helper. Boundaries here are API and MCP entry points, store calls, upstream calls, and CLI commands.
- **Attach identifiers as attributes** with `Effect.annotateCurrentSpan`, using dotted keys such as `client.id`, `tool.alias`, `connection.integration` and `invocation.outcome`. Never attach secrets or argument values.
- **Log with `Effect.logInfo` / `logWarning` / `logError` inside the span it belongs to**, so the log reaches the trace file. Put the error's tag in `Effect.annotateLogs({ "error.tag": … })`.

## Using it

- **A process with one runtime** uses `telemetryLayer(options)`.
- **A host with several runtimes** calls `makeTelemetry(options)` once, inside a scope that lives as long as the host, and provides `telemetry.layer` to each runtime. The gateway does this for HTTP, MCP and MCP OAuth. Call `telemetry.flush` before a host is frozen, as the Worker does with `ctx.waitUntil`.
- **Libraries that only accept a `fetch`** get `tracedFetch(context)`, which gives each request a client span and trace headers.
