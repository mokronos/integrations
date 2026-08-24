/** `bun run refresh` — put this working tree in charge of the machine.
 *
 * A gateway process holds its modules from the moment Bun loaded them, so a
 * gateway started before a commit keeps serving the older wire shape while
 * freshly started CLI processes decode with the newer one. The mismatch
 * surfaces as a schema error deep inside a response rather than as "restart
 * your gateway", which is what this script exists to prevent: stop the running
 * gateway, start one from these sources, and repoint the `i` and `ii` shims at
 * them.
 */
import { defaultGatewayPort, integrationsHome, readGatewayConfig } from "@mokronos/integrations-client"
import {
  installLocal,
  operatorProgram,
  parseInstallOptions
} from "../apps/cli/install-local.ts"
import {
  installService,
  serviceIsRegistered,
  serviceLabel,
  startDetachedGateway,
  stopGateway,
  stopService
} from "../apps/cli/src/service.ts"

const refresh = async (): Promise<void> => {
  await installLocal(await parseInstallOptions([]))

  const program = operatorProgram()
  // A registered unit is stopped through its service manager first, and only
  // then by pid: `Restart=on-failure` means a unit that is merely killed comes
  // back, and it would come back fighting whatever started next for the port.
  const registered = await serviceIsRegistered()
  if (registered) {
    await stopService()
    console.log(`stopped ${serviceLabel}`)
  }

  // Registered or not, the port may still be held by a gateway someone started
  // by hand — which is exactly the process a refresh needs gone.
  const stopped = await stopGateway()
  console.log(
    stopped === undefined
      ? "no other gateway was listening"
      : `stopped pid ${stopped.pid}${stopped.forced ? " (SIGTERM ignored, killed)" : ""}`
  )

  // The port the previous gateway used, so a non-default choice survives a
  // refresh. The bind address deliberately does not: exposing a port that
  // unlocks every connection stays an explicit `ii serve --host`.
  const port = (await readGatewayConfig(integrationsHome()))?.port ?? defaultGatewayPort

  if (registered) {
    // Rewrites the unit to run these sources, then restarts it.
    const descriptor = await installService({ program, port })
    console.log(`restarted ${serviceLabel} on port ${descriptor.port}`)
    return
  }
  const started = await startDetachedGateway({ program, port, host: "127.0.0.1" })
  console.log(`gateway listening at ${started.url} (pid ${started.pid})`)
  console.log(`logs: ${started.logPath}`)
}

try {
  await refresh()
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : "refresh failed"}`)
  process.exitCode = 1
}
