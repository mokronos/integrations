import path from "node:path"

/** Registering the gateway with the platform's per-user service manager.
 *
 * This deliberately repeats the shape of the dashboard's installer rather than
 * sharing it: `wf` depends on the gateway, not the other way round, so the
 * integrations app cannot import from the workflow CLI. The two units are also
 * genuinely different — a different label, home variable, port, and lifetime.
 * The gateway holds every credential and must survive the dashboard. */
export const serviceLabel = "dev.mokronos.integrations"

export const serviceLogPath = (home: string): string =>
  path.join(home, "logs", "integrations.log")
export const serviceErrorLogPath = (home: string): string =>
  path.join(home, "logs", "integrations.error.log")

export interface ServiceDescriptor {
  /** A program, not a single path: a compiled binary is one element, while a
   *  source install is ["<bun>", "<path to main.ts>"]. */
  readonly program: ReadonlyArray<string>
  readonly home: string
  readonly port: number
}

/** The arguments the unit runs. Loopback is not configurable here: a service
 *  that starts at login and exposes a credential-unlocking port to the network
 *  should be a deliberate `ii serve --host` in a terminal, not a
 *  default someone forgets is running. */
export const serviceArguments = (descriptor: ServiceDescriptor): ReadonlyArray<string> => [
  ...descriptor.program,
  "serve",
  "--port",
  String(descriptor.port)
]

export interface SystemdUnitOptions {
  readonly program: ReadonlyArray<string>
  readonly environment: Readonly<Record<string, string>>
  readonly workingDirectory: string
  readonly stdoutPath: string
  readonly stderrPath: string
}

const bareSystemdValue = /^[A-Za-z0-9_@%+=:,./-]+$/

export const systemdQuote = (value: string): string => {
  const escapedPercent = value.replaceAll("%", "%%")
  return bareSystemdValue.test(value)
    ? escapedPercent
    : `"${escapedPercent.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`
}

export const systemdUnit = (options: SystemdUnitOptions): string => {
  const command = options.program.map(systemdQuote).join(" ")
  const environment = Object.entries(options.environment)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n")
  return `[Unit]
Description=integrations gateway
After=default.target

[Service]
Type=simple
ExecStart=${command}
${environment}
WorkingDirectory=${systemdQuote(options.workingDirectory)}
StandardOutput=${systemdQuote(`append:${options.stdoutPath}`)}
StandardError=${systemdQuote(`append:${options.stderrPath}`)}
Restart=on-failure
RestartSec=3s

[Install]
WantedBy=default.target
`
}

const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")

export const launchdPlist = (descriptor: ServiceDescriptor): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${serviceLabel}</string>
  <key>ProgramArguments</key><array>
    ${serviceArguments(descriptor).map((value) => `<string>${xmlEscape(value)}</string>`).join("\n    ")}
  </array>
  <key>EnvironmentVariables</key><dict><key>INTEGRATIONS_HOME</key><string>${xmlEscape(descriptor.home)}</string></dict>
  <key>WorkingDirectory</key><string>${xmlEscape(descriptor.home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(serviceLogPath(descriptor.home))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(serviceErrorLogPath(descriptor.home))}</string>
</dict></plist>
`


