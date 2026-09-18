import { describe, expect, test } from "@effect/vitest"
import { createHash } from "node:crypto"
import { chmod, mkdir, readlink } from "node:fs/promises"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repositoryDirectory = path.resolve(import.meta.dirname, "../../..")
const installer = path.join(repositoryDirectory, "install.sh")
const decoder = new TextDecoder()

const run = (command: ReadonlyArray<string>, environment: Record<string, string | undefined>) => {
  const result = Bun.spawnSync({
    cmd: Array.from(command),
    cwd: repositoryDirectory,
    env: environment,
    stdout: "pipe",
    stderr: "pipe"
  })
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr)
  }
}

describe("release installer", () => {
  test("downloads, verifies, installs, and upgrades the managed executable", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "integrations-release-installer-"))
    const release = path.join(directory, "release")
    const staging = path.join(directory, "staging")
    const commands = path.join(directory, "commands")
    const binaries = path.join(directory, "bin")
    await Promise.all([mkdir(release), mkdir(staging), mkdir(commands)])

    const executable = path.join(staging, "integrations")
    await Bun.write(executable, "#!/bin/sh\nprintf '%s\\n' standalone-release\n")
    await chmod(executable, 0o755)
    const asset = "integrations-linux-x64.tar.gz"
    const archive = path.join(release, asset)
    const packed = run(["tar", "-czf", archive, "-C", staging, "integrations"], process.env)
    expect(packed.exitCode).toBe(0)

    const digest = createHash("sha256")
      .update(new Uint8Array(await Bun.file(archive).arrayBuffer()))
      .digest("hex")
    await Bun.write(path.join(release, "SHA256SUMS"), `${digest}  ${asset}\n`)

    const fakeCurl = path.join(commands, "curl")
    await Bun.write(fakeCurl, `#!/bin/sh
set -eu
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
cp "$FIXTURE_RELEASE/\${url##*/}" "$output"
`)
    await chmod(fakeCurl, 0o755)

    const environment = {
      ...process.env,
      FIXTURE_RELEASE: release,
      PATH: `${commands}:${binaries}:${process.env["PATH"] ?? ""}`
    }
    const first = run(["sh", installer, "--bin-dir", binaries], environment)
    expect(`install exit ${first.exitCode}: ${first.stderr}`).toBe("install exit 0: ")
    expect(first.stdout).toContain("integrations latest installed")
    expect(await readlink(path.join(binaries, "i"))).toBe("integrations")
    expect(await readlink(path.join(binaries, "ii"))).toBe("integrations")
    expect(run([path.join(binaries, "i")], environment).stdout).toBe("standalone-release\n")

    const upgrade = run(["sh", installer, "--bin-dir", binaries], environment)
    expect(`upgrade exit ${upgrade.exitCode}: ${upgrade.stderr}`).toBe("upgrade exit 0: ")
  })
})
