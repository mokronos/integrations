import { afterEach, describe, expect, test } from "bun:test"
import {
  telemetryAuthorizationEnvVar,
  telemetryAuthorizationFromEnv,
  telemetryEndpointEnvVar,
  telemetryEndpointFromEnv,
  traceSpanFromHeaders,
  type HeaderReader
} from "../src/telemetry.ts"

const setEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

const setEndpoint = (value: string | undefined): void =>
  setEnv(telemetryEndpointEnvVar, value)

const setAuthorization = (value: string | undefined): void =>
  setEnv(telemetryAuthorizationEnvVar, value)

const headersWith = (traceparent: string): HeaderReader => ({
  get: (name) => (name === "traceparent" ? traceparent : null)
})

const validTraceParent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

describe("telemetryEndpointFromEnv", () => {
  afterEach(() => setEndpoint(undefined))

  test("reads a configured endpoint", () => {
    setEndpoint("http://127.0.0.1:27686")
    expect(telemetryEndpointFromEnv()).toBe("http://127.0.0.1:27686")
  })

  test("trims surrounding whitespace", () => {
    setEndpoint("  http://127.0.0.1:27686  ")
    expect(telemetryEndpointFromEnv()).toBe("http://127.0.0.1:27686")
  })

  test("treats unset and blank as off", () => {
    expect(telemetryEndpointFromEnv()).toBeUndefined()
    setEndpoint("   ")
    expect(telemetryEndpointFromEnv()).toBeUndefined()
  })
})

describe("telemetryAuthorizationFromEnv", () => {
  afterEach(() => setAuthorization(undefined))

  test("reads a raw authorization header value", () => {
    setAuthorization("Basic dXNlcjpwYXNz")
    expect(telemetryAuthorizationFromEnv()).toBe("Basic dXNlcjpwYXNz")
  })

  test("trims and tolerates absence", () => {
    expect(telemetryAuthorizationFromEnv()).toBeUndefined()
    setAuthorization("  Basic dXNlcjpwYXNz  ")
    expect(telemetryAuthorizationFromEnv()).toBe("Basic dXNlcjpwYXNz")
    setAuthorization("")
    expect(telemetryAuthorizationFromEnv()).toBeUndefined()
  })
})

describe("traceSpanFromHeaders", () => {
  test("extracts ids and the sampled flag", () => {
    const span = traceSpanFromHeaders(headersWith(validTraceParent))
    expect(span?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
    expect(span?.spanId).toBe("00f067aa0ba902b7")
    expect(span?.sampled).toBe(true)
  })

  test("reports unsampled when the flag bit is clear", () => {
    const span = traceSpanFromHeaders(
      headersWith("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00")
    )
    expect(span?.sampled).toBe(false)
  })

  test("accepts uppercase hex", () => {
    const span = traceSpanFromHeaders(
      headersWith("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01")
    )
    expect(span?.traceId).toBe("4BF92F3577B34DA6A3CE929D0E0E4736")
  })

  test("rejects malformed headers", () => {
    for (
      const header of [
        "not-a-traceparent",
        "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "00-zbf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b-01",
        "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
        ""
      ]
    ) {
      expect(traceSpanFromHeaders(headersWith(header))).toBeUndefined()
    }
  })

  test("tolerates absent headers and header-like objects without the key", () => {
    expect(traceSpanFromHeaders({ get: () => null })).toBeUndefined()
    expect(traceSpanFromHeaders({ get: () => undefined })).toBeUndefined()
  })
})
