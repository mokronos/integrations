import path from "node:path"
import type { BunPlugin } from "bun"
import { Schema } from "effect"

const CompileTarget = Schema.Literals([
  "bun-linux-x64-baseline",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64"
])

const BuildOptions = Schema.Struct({
  target: CompileTarget,
  outfile: Schema.String
})
type BuildOptions = typeof BuildOptions.Type

const nativePackages = {
  "bun-linux-x64-baseline": "@libsql/linux-x64-gnu",
  "bun-linux-arm64": "@libsql/linux-arm64-gnu",
  "bun-darwin-x64": "@libsql/darwin-x64",
  "bun-darwin-arm64": "@libsql/darwin-arm64"
} as const satisfies Record<typeof CompileTarget.Type, string>

const usage = `Build a standalone integrations release executable.

Usage:
  bun run release:build --target <target> --outfile <path>
`

const parseOptions = (argv: ReadonlyArray<string>): BuildOptions => {
  const values: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if ((flag !== "--target" && flag !== "--outfile") || value === undefined) {
      throw new Error(usage)
    }
    values[flag.slice(2)] = value
  }
  return Schema.decodeUnknownSync(BuildOptions)(values)
}

const repositoryDirectory = path.resolve(import.meta.dirname, "..")
const webDirectory = path.join(repositoryDirectory, "apps", "web", "dist")

const webAssetModule = async (): Promise<string> => {
  const paths = (await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: webDirectory, onlyFiles: true })
  )).sort()
  if (!paths.includes("index.html")) {
    throw new Error(`Built dashboard not found at ${webDirectory}`)
  }

  const imports = paths.map((relativePath, index) =>
    `import asset${index} from ${JSON.stringify(path.join(webDirectory, relativePath))} with { type: "file" }`
  )
  const records = paths.map((relativePath, index) =>
    `  { path: ${JSON.stringify(relativePath)}, source: asset${index} }`
  )
  return `${imports.join("\n")}\n\nexport const embeddedWebAssets = [\n${records.join(",\n")}\n]\n`
}

const nativePackageFile = (packageName: string): string => {
  const directoryName = packageName.replace("/", "+")
  const pattern = `node_modules/.bun/${directoryName}@*/node_modules/${packageName}/index.node`
  const matches = Array.from(new Bun.Glob(pattern).scanSync({
    cwd: repositoryDirectory,
    dot: true
  }))
  const match = matches[0]
  if (match === undefined) {
    throw new Error(`${packageName} is not installed; run bun install --os '*' --cpu '*'`)
  }
  return path.join(repositoryDirectory, match)
}

const releasePlugin = (target: typeof CompileTarget.Type): BunPlugin => {
  const nativePackage = nativePackages[target]
  return {
    name: "integrations-release",
    setup(build) {
      build.onResolve({ filter: /^integrations:embedded-web$/ }, () => ({
        path: "embedded-web",
        namespace: "integrations-release"
      }))
      build.onLoad(
        { filter: /^embedded-web$/, namespace: "integrations-release" },
        async () => ({ contents: await webAssetModule(), loader: "ts" })
      )
      build.onLoad({ filter: /\/libsql\/index\.js$/ }, async (arguments_) => {
        const source = await Bun.file(arguments_.path).text()
        const dynamicRequire = "return require(`@libsql/${target}`);"
        const specialized = source.replace(
          dynamicRequire,
          `return require(${JSON.stringify(nativePackage)});`
        )
        if (specialized === source) {
          throw new Error(`Could not specialize the native libSQL loader at ${arguments_.path}`)
        }
        return { contents: specialized, loader: "js" }
      })
      build.onResolve({ filter: /^@libsql\/(?:linux|darwin)-/ }, (arguments_) => ({
        path: nativePackageFile(arguments_.path)
      }))
      build.onResolve({ filter: /^jsonc-parser$/ }, (arguments_) => {
        const commonJs = Bun.resolveSync("jsonc-parser", arguments_.resolveDir)
        return { path: commonJs.replace(`${path.sep}umd${path.sep}`, `${path.sep}esm${path.sep}`) }
      })
    }
  }
}

const main = async (): Promise<void> => {
  const options = parseOptions(process.argv.slice(2))
  const result = await Bun.build({
    entrypoints: [path.join(repositoryDirectory, "apps", "cli", "src", "standalone.ts")],
    compile: { target: options.target, outfile: path.resolve(options.outfile) },
    minify: true,
    plugins: [releasePlugin(options.target)]
  })
  if (!result.success) {
    for (const log of result.logs) console.error(JSON.stringify(log))
    throw new Error("Standalone build failed")
  }
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
