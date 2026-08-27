import { afterEach, describe, expect, test } from "bun:test"
import {
  telemetryAuthorizationEnvVar,
  telemetryAuthorizationFromEnv,
  telemetryEndpointEnvVar,
  telemetryEndpointFromEnv
} from "../src/telemetry.ts"

const setEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

const setEndpoint = (value: string | undefined): void =>
  setEnv(telemetryEndpointEnvVar, value)

const setAuthorization = (value: string | undefined): void =>
  setEnv(telemetryAuthorizationEnvVar, value)

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
