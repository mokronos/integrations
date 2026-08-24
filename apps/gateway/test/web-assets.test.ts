import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createWebAssets } from "../src/index.ts"

const directories: Array<string> = []
const previous = process.env["INTEGRATIONS_WEB_DIR"]

afterEach(async () => {
  if (previous === undefined) delete process.env["INTEGRATIONS_WEB_DIR"]
  else process.env["INTEGRATIONS_WEB_DIR"] = previous
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

/** A stand-in for `vite build` output: an entry document and one hashed asset. */
const buildOutput = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "wf-web-assets-"))
  directories.push(directory)
  await writeFile(path.join(directory, "index.html"), "<!doctype html><title>control</title>")
  await mkdir(path.join(directory, "assets"), { recursive: true })
  await writeFile(path.join(directory, "assets", "index-abc.js"), "console.log(1)")
  process.env["INTEGRATIONS_WEB_DIR"] = directory
  return directory
}

describe("control plane assets", () => {
  test("serves the entry document at the root", async () => {
    await buildOutput()
    const assets = await createWebAssets()

    const response = await assets.respond("/")

    expect(response?.status).toBe(200)
    expect(response?.headers.get("content-type")).toBe("text/html; charset=utf-8")
  })

  test("serves built files with the content type a browser needs", async () => {
    await buildOutput()
    const assets = await createWebAssets()

    const response = await assets.respond("/assets/index-abc.js")

    expect(response?.status).toBe(200)
    expect(response?.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
  })

  test("falls back to the entry document for a client-side route", async () => {
    await buildOutput()
    const assets = await createWebAssets()

    // /clients/cl_7 exists in the router, never on disk. Reloading it must work.
    const response = await assets.respond("/clients/cl_7")

    expect(response?.status).toBe(200)
    expect(await response?.text()).toContain("<title>control</title>")
  })

  test("a missing asset is a miss, not the entry document", async () => {
    await buildOutput()
    const assets = await createWebAssets()

    // Serving HTML for a broken script tag turns a build mistake into a blank
    // page with no explanation.
    expect(await assets.respond("/assets/gone.js")).toBeUndefined()
  })

  test("refuses to escape the build directory", async () => {
    await buildOutput()
    const assets = await createWebAssets()

    for (const pathname of ["/../../etc/passwd", "/assets/../../../../etc/passwd"]) {
      expect(await assets.respond(pathname)).toBeUndefined()
    }
  })

  test("says what to build when there is nothing to serve", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "wf-web-missing-"))
    directories.push(empty)

    const assets = await createWebAssets({ directories: [path.join(empty, "nope")] })
    const response = await assets.respond("/")

    expect(assets.directory).toBeUndefined()
    expect(response?.status).toBe(503)
    expect(await response?.text()).toContain("bun run --cwd apps/web build")
  })
})
