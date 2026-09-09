import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Option } from "effect"
import type { Config } from "effect"
import {
  telemetryAuthorization,
  telemetryAuthorizationEnvVar,
  telemetryEndpoint,
  telemetryEndpointEnvVar
} from "../src/telemetry.ts"

/** Reads a setting against a fixed environment, without touching the real one. */
const read = (
  config: Config.Config<Option.Option<string>>,
  env: Record<string, string>
): string | undefined =>
  Effect.runSync(
    config.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
      Effect.map(Option.getOrUndefined)
    )
  )

describe("the telemetry endpoint setting", () => {
  test("reads a configured endpoint", () => {
    expect(read(telemetryEndpoint, { [telemetryEndpointEnvVar]: "http://127.0.0.1:27686" }))
      .toBe("http://127.0.0.1:27686")
  })

  test("trims surrounding whitespace", () => {
    expect(read(telemetryEndpoint, { [telemetryEndpointEnvVar]: "  http://127.0.0.1:27686  " }))
      .toBe("http://127.0.0.1:27686")
  })

  test("treats unset and blank as off", () => {
    expect(read(telemetryEndpoint, {})).toBeUndefined()
    expect(read(telemetryEndpoint, { [telemetryEndpointEnvVar]: "   " })).toBeUndefined()
  })
})

describe("the telemetry authorization setting", () => {
  test("reads a raw authorization header value", () => {
    expect(read(telemetryAuthorization, { [telemetryAuthorizationEnvVar]: "Basic dXNlcjpwYXNz" }))
      .toBe("Basic dXNlcjpwYXNz")
  })

  test("trims and tolerates absence", () => {
    expect(read(telemetryAuthorization, {})).toBeUndefined()
    expect(read(telemetryAuthorization, { [telemetryAuthorizationEnvVar]: "  Basic dXNlcjpwYXNz  " }))
      .toBe("Basic dXNlcjpwYXNz")
    expect(read(telemetryAuthorization, { [telemetryAuthorizationEnvVar]: "" })).toBeUndefined()
  })
})
