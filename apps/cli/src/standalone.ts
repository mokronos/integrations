#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { integrationsHome } from "@integragents/client"
import { embeddedWebAssets } from "integrations:embedded-web"
import packageMetadata from "../package.json" with { type: "json" }
import { main as agentMain } from "./agent.ts"
import { main as operatorMain } from "./main.ts"

const webDirectory = async (): Promise<string> => {
  const directory = path.join(
    integrationsHome(),
    "runtime",
    packageMetadata.version,
    "web"
  )
  const marker = path.join(directory, ".complete")
  if (await Bun.file(marker).exists()) return directory

  for (const asset of embeddedWebAssets) {
    const destination = path.resolve(directory, asset.path)
    if (!destination.startsWith(`${directory}${path.sep}`)) {
      throw new Error(`Invalid embedded web asset path: ${asset.path}`)
    }
    await mkdir(path.dirname(destination), { recursive: true })
    await Bun.write(destination, Bun.file(asset.source))
  }
  await Bun.write(marker, `${packageMetadata.version}\n`)
  return directory
}

const executableName = (): string => path.basename(process.argv0)

export const standaloneMain = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (executableName() === "i") {
    await agentMain(argv)
    return
  }

  if (argv[0] === "serve") {
    process.env["INTEGRATIONS_WEB_DIR"] = await webDirectory()
  }
  await operatorMain(argv)
}

if (import.meta.main) {
  try {
    await standaloneMain(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
