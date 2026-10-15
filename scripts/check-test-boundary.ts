/**
 * Black-box tests drive the product from outside, through its CLIs, HTTP, MCP,
 * and the published client, so they import none of its internals.
 *
 *   bun run scripts/check-test-boundary.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

const root = path.resolve(import.meta.dirname, "..")

const blackBoxTests = [
  "apps/cli/test/acceptance.test.ts",
  "apps/cli/test/remote.acceptance.ts",
  "apps/host-cloudflare/test"
]

const allowedPackages = [
  "effect",
  "vitest",
  "@effect/vitest",
  "@modelcontextprotocol/client",
  "@integragents/client",
  "@integragents/contracts",
  "alchemy"
]

/** Deployments a test stands up and then talks to over the network. */
const harnesses = new Set(["apps/host-cloudflare/alchemy.run.ts"].map((file) => path.join(root, file)))

const isPackageAllowed = (specifier: string): boolean =>
  specifier.startsWith("node:") ||
  allowedPackages.some((name) => specifier === name || specifier.startsWith(`${name}/`))

const filesUnder = (entry: string): ReadonlyArray<string> =>
  statSync(entry).isDirectory()
    ? readdirSync(entry).flatMap((name) => filesUnder(path.join(entry, name)))
    : /\.[cm]?tsx?$/.test(entry)
      ? [entry]
      : []

const moduleSpecifiers = (source: ts.SourceFile): ReadonlyArray<ts.StringLiteral> => {
  const found: Array<ts.StringLiteral> = []
  const visit = (node: ts.Node): void => {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
          ? node.argument.literal
          : ts.isCallExpression(node) &&
              (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === "require"))
            ? node.arguments[0]
            : undefined
    if (specifier !== undefined && ts.isStringLiteral(specifier)) found.push(specifier)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const problems: Array<string> = []
const checked = new Set<string>()

const check = (file: string, testDirectory: string): void => {
  if (checked.has(file)) return
  checked.add(file)
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  for (const literal of moduleSpecifiers(source)) {
    const specifier = literal.text
    if (specifier.startsWith(".")) {
      const target = path.resolve(path.dirname(file), specifier)
      if (harnesses.has(target)) continue
      if (target.startsWith(`${testDirectory}${path.sep}`)) {
        check(target, testDirectory)
        continue
      }
    } else if (isPackageAllowed(specifier)) {
      continue
    }
    const { line } = source.getLineAndCharacterOfPosition(literal.getStart())
    problems.push(`${path.relative(root, file)}:${line + 1}: imports ${specifier}`)
  }
}

for (const entry of blackBoxTests) {
  const absolute = path.join(root, entry)
  const testDirectory = statSync(absolute).isDirectory() ? absolute : path.dirname(absolute)
  for (const file of filesUnder(absolute)) check(file, testDirectory)
}

if (problems.length > 0) {
  console.error(`Black-box tests may only reach the product from outside:\n${problems.join("\n")}`)
  process.exit(1)
}
console.log(`test boundary: ${checked.size} files import no product internals`)
