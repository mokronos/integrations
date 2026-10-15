import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { $ } from "bun"

const REFERENCE_DIR = join(import.meta.dirname, "../.reference")

interface Repo {
  readonly name: string
  readonly url: string
  /** Other branches, each checked out as a worktree at `.reference/<name>`. */
  readonly branches?: ReadonlyArray<{ readonly name: string; readonly branch: string }>
}

const repos: ReadonlyArray<Repo> = [
  { name: "effect", url: "https://github.com/Effect-TS/effect.git" },
  { name: "effect-atom", url: "https://github.com/tim-smart/effect-atom.git" },
  { name: "tanstack-router", url: "https://github.com/TanStack/router.git" },
  {
    name: "executor",
    url: "https://github.com/UsefulSoftwareCo/executor.git",
    branches: [{ name: "executor-v2", branch: "v2" }]
  }
]

await mkdir(REFERENCE_DIR, { recursive: true })

for (const repo of repos) {
  const dest = join(REFERENCE_DIR, repo.name)
  if (existsSync(dest)) {
    console.log(`Pulling ${repo.name}...`)
    await $`git -C ${dest} pull --ff-only`.quiet()
  } else {
    console.log(`Cloning ${repo.name}...`)
    await $`git clone --depth 1 ${repo.url} ${dest}`.quiet()
  }
  console.log(`  ✓ ${repo.name}`)

  for (const { name, branch } of repo.branches ?? []) {
    const worktree = join(REFERENCE_DIR, name)
    await $`git -C ${dest} fetch --depth 1 origin +${branch}:refs/remotes/origin/${branch}`.quiet()
    if (existsSync(worktree)) {
      await $`git -C ${worktree} checkout --detach origin/${branch}`.quiet()
    } else {
      await $`git -C ${dest} worktree add --detach ${worktree} origin/${branch}`.quiet()
    }
    console.log(`  ✓ ${name} (${branch})`)
  }
}
