import { rm } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import * as BunServices from "@effect/platform-bun/BunServices"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { FetchHttpClient, type HttpClient } from "effect/unstable/http"
import { defaultGatewayPort, integrationsHome, readGatewayConfig } from "@integragents/client"
import { operatorProgram } from "../apps/cli/install-local.ts"
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

/**
 * What the gateway holds that only means something alongside its tables: the
 * database, the blobs its rows address, and the config naming an API key that
 * belongs to a client row. The master key stays, because it encrypts the data
 * rather than being any of it, and so do the logs and anything downloaded.
 */
const discardedEntries = ["gateway.sqlite", "gateway.sqlite-wal", "gateway.sqlite-shm", "blobs", "gateway.json"] as const

export const usage = `Delete this machine's gateway database and start over.

Usage:
  bun run db:reset [--yes]

The gateway is stopped, its database, blobs and config are removed, and it is
started again on the port it was using, which re-runs the migrations and mints
a fresh local API key. The master key in gateway.key is kept.
`

const confirmed = async (home: string, force: boolean): Promise<boolean> => {
  if (force) return true
  if (process.stdin.isTTY !== true) {
    console.error(`error: nothing to confirm on, so ${home} was left alone; pass --yes to mean it`)
    return false
  }
  const answer = prompt(`Delete the gateway database and blobs under ${home}? [y/N]`)
  return answer !== null && /^y(es)?$/i.test(answer.trim())
}

const reset = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage)
    return
  }
  const home = integrationsHome()
  if (!await confirmed(home, argv.includes("--yes") || argv.includes("-y"))) {
    process.exitCode = 1
    return
  }

  // The port lives in the config this is about to delete, so it is read first.
  const port = (await readGatewayConfig(home))?.port ?? defaultGatewayPort

  const registered = await serviceIsRegistered()
  if (registered) {
    await run(stopService())
    console.log(`stopped ${serviceLabel}`)
  }
  const stopped = await run(stopGateway())
  console.log(
    stopped === undefined
      ? "no gateway was listening"
      : `stopped pid ${stopped.pid}${stopped.forced ? " (SIGTERM ignored, killed)" : ""}`
  )

  for (const entry of discardedEntries) {
    await rm(path.join(home, entry), { recursive: true, force: true })
  }
  console.log(`discarded ${discardedEntries.join(", ")} from ${home}`)

  const program = operatorProgram()
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
  await reset(process.argv.slice(2))
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : "reset failed"}`)
  process.exitCode = 1
}
