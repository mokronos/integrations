import { describe, expect, test } from "@effect/vitest"
import {
  launchdPlist,
  serviceArguments,
  serviceEnvironment,
  serviceLabel,
  systemdQuote,
  systemdUnit
} from "../src/service.ts"

const descriptor = { program: ["/opt/integrations"], home: "/tmp/integrations", port: 4788 } as const

describe("gateway service definitions", () => {
  test("runs the gateway on loopback with the installed port", () => {
    expect(serviceArguments(descriptor)).toEqual([
      "/opt/integrations",
      "serve",
      "--port",
      "4788"
    ])
  })

  test("quotes systemd values and escapes specifier percents", () => {
    expect(systemdQuote("/tmp/integrations home")).toBe('"/tmp/integrations home"')
    expect(systemdQuote("/tmp/integrations%20home")).toBe("/tmp/integrations%%20home")
    expect(systemdQuote("/tmp/integrations % home")).toBe('"/tmp/integrations %% home"')
  })

  test("writes a systemd unit that serves the gateway from the recorded home", () => {
    const unit = systemdUnit({
      program: serviceArguments({ ...descriptor, home: "/tmp/integrations home" }),
      environment: { INTEGRATIONS_HOME: "/tmp/integrations home" },
      workingDirectory: "/tmp/integrations home",
      stdoutPath: "/tmp/integrations home/logs/integrations.log",
      stderrPath: "/tmp/integrations home/logs/integrations.error.log"
    })

    expect(unit).toContain("ExecStart=/opt/integrations serve --port 4788")
    expect(unit).toContain('Environment="INTEGRATIONS_HOME=/tmp/integrations home"')
    expect(unit).toContain('WorkingDirectory="/tmp/integrations home"')
    expect(unit).toContain("Restart=on-failure")
  })

  test("writes a launchd definition under its own label", () => {
    const plist = launchdPlist(descriptor, { INTEGRATIONS_HOME: "/tmp/integrations" })

    expect(plist).toContain(`<string>${serviceLabel}</string>`)
    expect(plist).toContain("<string>serve</string>")
    expect(plist).toContain("<string>/opt/integrations</string>")
    expect(plist).toContain("<key>INTEGRATIONS_HOME</key><string>/tmp/integrations</string>")
  })

  test("keeps every program element for a source install", () => {
    const program = ["/home/me/.bun/bin/bun", "/repo/apps/cli/src/main.ts"]

    expect(launchdPlist({ ...descriptor, program }, { INTEGRATIONS_HOME: "/tmp/integrations" }))
      .toContain("<string>/repo/apps/cli/src/main.ts</string>")
    expect(systemdUnit({
      program: serviceArguments({ ...descriptor, program }),
      environment: { INTEGRATIONS_HOME: "/tmp/integrations" },
      workingDirectory: "/tmp/integrations",
      stdoutPath: "/tmp/integrations/logs/integrations.log",
      stderrPath: "/tmp/integrations/logs/integrations.error.log"
    })).toContain(
      "ExecStart=/home/me/.bun/bin/bun /repo/apps/cli/src/main.ts serve --port 4788"
    )
  })

  test("carries the installer's telemetry settings into the service and nothing else", () => {
    expect(serviceEnvironment("/tmp/integrations", {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
      OTEL_TRACES_EXPORTER: "otlp",
      INTEGRATIONS_LOG_LEVEL: "Debug",
      INTEGRATIONS_HOME: "/elsewhere",
      AWS_SECRET_ACCESS_KEY: "not for the gateway"
    })).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
      OTEL_TRACES_EXPORTER: "otlp",
      INTEGRATIONS_LOG_LEVEL: "Debug",
      INTEGRATIONS_HOME: "/tmp/integrations"
    })
  })
})
