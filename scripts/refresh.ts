import { Effect, Layer } from "effect"
import * as BunServices from "@effect/platform-bun/BunServices"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { FetchHttpClient, type HttpClient } from "effect/unstable/http"
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

const run = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(
    Effect.provide(Layer.merge(FetchHttpClient.layer, BunServices.layer))
  ))

const refresh = async (): Promise<void> => {
  await installLocal(await parseInstallOptions([]))

  const program = operatorProgram()
  const registered = await serviceIsRegistered()
  if (registered) {
    await run(stopService())
    console.log(`stopped ${serviceLabel}`)
  }

  const stopped = await run(stopGateway())
  console.log(
    stopped === undefined
      ? "no other gateway was listening"
      : `stopped pid ${stopped.pid}${stopped.forced ? " (SIGTERM ignored, killed)" : ""}`
  )

  const port = (await readGatewayConfig(integrationsHome()))?.port ?? defaultGatewayPort

  if (registered) {
    const descriptor = await run(installService({ program, port }))
    console.log(`restarted ${serviceLabel} on port ${descriptor.port}`)
    return
  }
  const started = await run(startDetachedGateway({ program, port, host: "127.0.0.1" }))
  console.log(`gateway listening at ${started.url} (pid ${started.pid})`)
  console.log(`logs: ${started.logPath}`)
}

try {
  await refresh()
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : "refresh failed"}`)
  process.exitCode = 1
}
