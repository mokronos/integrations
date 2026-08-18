import { describe, expect, test } from "bun:test"
import {
  launchdPlist,
  serviceArguments,
  serviceLabel,
  systemdQuote,
  systemdUnit
} from "../src/service.ts"

const descriptor = { program: ["/opt/integrations"], home: "/tmp/wf", port: 4788 } as const

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
    expect(systemdQuote("/tmp/wf home")).toBe('"/tmp/wf home"')
    expect(systemdQuote("/tmp/wf%20home")).toBe("/tmp/wf%%20home")
    expect(systemdQuote("/tmp/wf % home")).toBe('"/tmp/wf %% home"')
  })

  test("writes a systemd unit that serves the gateway from the recorded home", () => {
    const unit = systemdUnit({
      program: serviceArguments({ ...descriptor, home: "/tmp/wf home" }),
      environment: { INTEGRATIONS_HOME: "/tmp/wf home" },
      workingDirectory: "/tmp/wf home",
      stdoutPath: "/tmp/wf home/logs/integrations.log",
      stderrPath: "/tmp/wf home/logs/integrations.error.log"
    })

    expect(unit).toContain("ExecStart=/opt/integrations serve --port 4788")
    expect(unit).toContain('Environment="INTEGRATIONS_HOME=/tmp/wf home"')
    expect(unit).toContain('WorkingDirectory="/tmp/wf home"')
    expect(unit).toContain("Restart=on-failure")
  })

  test("writes a launchd definition under its own label", () => {
    const plist = launchdPlist(descriptor)

    expect(plist).toContain(`<string>${serviceLabel}</string>`)
    expect(plist).toContain("<string>serve</string>")
    expect(plist).toContain("<string>/opt/integrations</string>")
    expect(plist).toContain("<key>INTEGRATIONS_HOME</key><string>/tmp/wf</string>")
    // Its own label, because the gateway holds the credentials the dashboard
    // service reads and has to be able to outlive it.
    expect(serviceLabel).not.toBe("dev.mokronos.wf")
  })

  test("keeps every program element for a source install", () => {
    const program = ["/home/me/.bun/bin/bun", "/repo/apps/integrations/cli/src/main.ts"]

    expect(launchdPlist({ ...descriptor, program }))
      .toContain("<string>/repo/apps/integrations/cli/src/main.ts</string>")
    expect(systemdUnit({
      program: serviceArguments({ ...descriptor, program }),
      environment: { INTEGRATIONS_HOME: "/tmp/wf" },
      workingDirectory: "/tmp/wf",
      stdoutPath: "/tmp/wf/logs/integrations.log",
      stderrPath: "/tmp/wf/logs/integrations.error.log"
    })).toContain(
      "ExecStart=/home/me/.bun/bin/bun /repo/apps/integrations/cli/src/main.ts serve --port 4788"
    )
  })
})
