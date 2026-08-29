import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { serveGateway } from "@mokronos/integrations"
import type { RunningGateway } from "@mokronos/integrations"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const agentCli = path.join(repoRoot, "apps", "cli", "src", "agent.ts")
const operatorCli = path.join(repoRoot, "apps", "cli", "src", "main.ts")

const servers: Array<ReturnType<typeof Bun.serve>> = []
const gateways: Array<RunningGateway> = []
/** Decodes CLI output against the shape a test expects. Using a schema rather
 *  than a cast means the test fails when the CLI's output drifts, which is the
 *  whole point of an acceptance test. Struct ignores excess properties, so a
 *  command is still free to report more than the test names. */
const parseOutput = <A>(schema: Schema.Codec<A>, text: string): A =>
  Schema.decodeUnknownSync(schema)(JSON.parse(text))

const ApiKeyConfig = Schema.Struct({ apiKey: Schema.String })
const IdOutput = Schema.Struct({ id: Schema.String })
const SecretOutput = Schema.Struct({ secret: Schema.String })
const KeyOutput = Schema.Struct({ id: Schema.String, secret: Schema.String })
const CountOutput = Schema.Struct({ count: Schema.Number })
const DiscoveredOutput = Schema.Struct({
  integration: Schema.Struct({ slug: Schema.String })
})
const ConnectionsOutput = Schema.Struct({
  connections: Schema.Array(Schema.Struct({ address: Schema.String, name: Schema.String }))
})
const DirectOutcome = Schema.Struct({
  status: Schema.String,
  result: Schema.Struct({ title: Schema.String })
})
const ToolsOutput = Schema.Struct({
  count: Schema.Number,
  tools: Schema.Array(Schema.Struct({ name: Schema.String })),
  showing: Schema.optional(Schema.Number)
})
const WindowedToolsOutput = Schema.Struct({
  count: Schema.Number,
  showing: Schema.Number,
  offset: Schema.Number,
  tools: Schema.Array(Schema.Json)
})
const KeysOutput = Schema.Struct({
  keys: Schema.Array(Schema.Struct({
    id: Schema.String,
    revokedAt: Schema.NullOr(Schema.String)
  }))
})
const AuthenticationOutput = Schema.Struct({
  authenticated: Schema.Boolean,
  email: Schema.optional(Schema.String)
})
const CatalogOutput = Schema.Struct({
  oauthCallbackUrl: Schema.optional(Schema.NullOr(Schema.String))
})

const directories: Array<string> = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()))
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

const run = async (
  cli: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>>
) => {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, "run", cli, ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: environment
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text()
  ])
  return { exitCode, stdout, stderr }
}

/** A vendor: an OpenAPI document plus the endpoint it describes, guarded by an
 *  API key the gateway must inject. */
const startVendor = () => {
  let invocations = 0
  const seenKeys: Array<string | null> = []
  const server = Bun.serve({
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      const baseUrl = `http://127.0.0.1:${server.port}`
      if (url.pathname === "/api/search") {
        return Response.json({
          results: [{
            domain: "acceptance.test",
            name: "Acceptance Tickets",
            description: "Creates tickets for the acceptance journey",
            kinds: ["openapi"],
            url: baseUrl
          }]
        })
      }
      if (url.pathname === "/api/acceptance.test/surface") {
        return Response.json({
          surfaces: [{
            type: "openapi",
            slug: "acceptance-tickets",
            name: "Acceptance Tickets",
            spec: `${baseUrl}/openapi.json`
          }]
        })
      }
      if (url.pathname === "/openapi.json") {
        return Response.json({
          openapi: "3.1.0",
          info: { title: "Acceptance", version: "1.0.0", description: "Creates tickets" },
          servers: [{ url: baseUrl }],
          security: [{ apiKey: [] }],
          paths: {
            "/tickets": {
              post: {
                operationId: "tickets.create",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["title"],
                        properties: { title: { type: "string" } }
                      }
                    }
                  }
                },
                responses: {
                  "200": {
                    description: "Created",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          required: ["id", "title"],
                          properties: { id: { type: "string" }, title: { type: "string" } }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          components: {
            securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-api-key" } }
          }
        })
      }
      if (url.pathname !== "/tickets") return new Response("not found", { status: 404 })
      seenKeys.push(request.headers.get("x-api-key"))
      const body = await Schema.decodeUnknownPromise(
        Schema.Struct({ title: Schema.String })
      )(await request.json())
      invocations += 1
      return Response.json({ id: "T-1", title: body.title })
    }
  })
  servers.push(server)
  return {
    specUrl: `http://127.0.0.1:${server.port}/openapi.json`,
    registryUrl: `http://127.0.0.1:${server.port}`,
    invocations: () => invocations,
    seenKeys: () => seenKeys
  }
}

const startGateway = async (registryUrl?: string) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "integrations-acceptance-"))
  directories.push(home)
  const gateway = registryUrl === undefined
    ? await serveGateway({ home, port: 0 })
    : await serveGateway({ home, port: 0, registryUrl })
  gateways.push(gateway)
  const config = await readFile(path.join(home, "gateway.json"), "utf8")
  const { apiKey } = parseOutput(ApiKeyConfig, config)
  return {
    home,
    url: gateway.url,
    apiKey,
    environment: {
      ...process.env,
      INTEGRATIONS_HOME: home,
      INTEGRATIONS_URL: gateway.url,
      INTEGRATIONS_API_KEY: apiKey,
      ACCEPTANCE_TOKEN: "acceptance-secret",
      NO_COLOR: "1"
    }
  }
}

const startHostedGateway = async () => {
  const serverHome = await mkdtemp(path.join(os.tmpdir(), "integrations-hosted-server-"))
  const clientHome = await mkdtemp(path.join(os.tmpdir(), "integrations-hosted-client-"))
  directories.push(serverHome, clientHome)
  const gateway = await serveGateway({
    home: serverHome,
    hostname: "0.0.0.0",
    port: 0,
    publicUrl: "https://gateway.example"
  })
  gateways.push(gateway)
  return {
    url: `http://127.0.0.1:${gateway.port}`,
    environment: {
      ...process.env,
      INTEGRATIONS_HOME: clientHome,
      INTEGRATIONS_URL: `http://127.0.0.1:${gateway.port}`,
      INTEGRATIONS_API_KEY: undefined,
      NO_COLOR: "1"
    }
  }
}

const loginOperator = async (
  gateway: Awaited<ReturnType<typeof startGateway>>
): Promise<void> => {
  const signedUp = await run(operatorCli, [
    "signup",
    "--password",
    "correct horse battery",
    "operator@example.com"
  ], gateway.environment)
  expect(signedUp.exitCode, signedUp.stderr).toBe(0)
}

describe("integrations CLI acceptance", () => {
  test("hosted ii uses a login session while i uses only its delegated API key", async () => {
    const gateway = await startHostedGateway()
    const operator = (args: ReadonlyArray<string>) =>
      run(operatorCli, args, gateway.environment)

    const signedUp = await operator([
      "signup",
      "--password",
      "correct horse battery",
      "hosted@example.com"
    ])
    expect(signedUp.exitCode, signedUp.stderr).toBe(0)

    const catalog = await operator(["integrations"])
    expect(catalog.exitCode, catalog.stderr).toBe(0)

    const login = await fetch(`${gateway.url}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "hosted@example.com",
        password: "correct horse battery"
      })
    })
    expect(login.status).toBe(200)
    const setCookie = login.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain("Secure")
    const cookie = setCookie.split(";", 1)[0] ?? ""
    const hostedCatalogResponse = await fetch(`${gateway.url}/v1/integrations`, {
      headers: { cookie }
    })
    expect(hostedCatalogResponse.status).toBe(200)
    const hostedCatalog = Schema.decodeUnknownSync(CatalogOutput)(
      await hostedCatalogResponse.json()
    )
    expect(hostedCatalog.oauthCallbackUrl).toBe(
      "https://gateway.example/v1/oauth/callback"
    )

    const client = parseOutput(
      IdOutput,
      (await operator(["client", "remote-agent", "--provision"])).stdout
    )
    const key = parseOutput(SecretOutput, (await operator(["key", client.id])).stdout)
    const agentEnvironment = {
      ...gateway.environment,
      INTEGRATIONS_API_KEY: key.secret
    }
    const connections = await run(agentCli, ["connections"], agentEnvironment)
    expect(connections.exitCode, connections.stderr).toBe(0)
    expect(parseOutput(ConnectionsOutput, connections.stdout).connections).toEqual([])

    const administrative = await run(agentCli, ["clients"], agentEnvironment)
    expect(administrative.exitCode).not.toBe(0)
    expect(administrative.stderr).toContain("Unknown subcommand")

    expect((await operator(["logout"])).exitCode).toBe(0)
    const afterLogout = await operator(["clients"])
    expect(afterLogout.exitCode).not.toBe(0)
    expect(afterLogout.stderr).toContain("No operator credential found")
  }, 40_000)

  test("ii signs a human out and back in without an API key", async () => {
    const gateway = await startGateway()
    await loginOperator(gateway)
    const environment = { ...gateway.environment, INTEGRATIONS_API_KEY: undefined }
    const operator = (args: ReadonlyArray<string>) => run(operatorCli, args, environment)

    const signedIn = parseOutput(AuthenticationOutput, (await operator(["whoami"])).stdout)
    expect(signedIn).toEqual({ authenticated: true, email: "operator@example.com" })

    const logout = await operator(["logout"])
    expect(logout.exitCode, logout.stderr).toBe(0)
    const signedOut = parseOutput(AuthenticationOutput, (await operator(["whoami"])).stdout)
    expect(signedOut).toEqual({ authenticated: false })

    const login = await operator([
      "login",
      "--password",
      "correct horse battery",
      "operator@example.com"
    ])
    expect(login.exitCode, login.stderr).toBe(0)
    const signedInAgain = parseOutput(AuthenticationOutput, (await operator(["whoami"])).stdout)
    expect(signedInAgain).toEqual({ authenticated: true, email: "operator@example.com" })
  }, 30_000)

  test(
    "an agent searches, discovers, connects, inspects, and invokes a connection — all through the gateway",
    async () => {
      const vendor = startVendor()
      const gateway = await startGateway(vendor.registryUrl)
      const integrations = (args: ReadonlyArray<string>) =>
        run(agentCli, args, gateway.environment)

      const searched = await integrations(["search", "acceptance tickets"])
      expect(searched.exitCode, searched.stderr).toBe(0)
      const SearchBody = Schema.Struct({
        query: Schema.String,
        results: Schema.Array(Schema.Struct({
          name: Schema.String,
          surfaces: Schema.Array(Schema.Struct({ url: Schema.optional(Schema.String) }))
        }))
      })
      const searchBody = Schema.decodeUnknownSync(SearchBody)(JSON.parse(searched.stdout))
      expect(searchBody.query).toBe("acceptance tickets")
      expect(searchBody.results).toHaveLength(1)
      expect(searchBody.results[0]?.name).toBe("Acceptance Tickets")
      const discoveryUrl = searchBody.results[0]?.surfaces[0]?.url
      expect(discoveryUrl).toBe(vendor.specUrl)

      const discovered = await integrations(["discover", discoveryUrl ?? ""])
      expect(discovered.exitCode, discovered.stderr).toBe(0)
      const DiscoverBody = Schema.Struct({
        integration: Schema.Struct({ slug: Schema.String }),
        next: Schema.String
      })
      const discoveredBody = Schema.decodeUnknownSync(DiscoverBody)(
        JSON.parse(discovered.stdout)
      )
      const slug = discoveredBody.integration.slug
      // Listings tell an agent what to do next rather than making it guess.
      expect(discoveredBody.next).toBe(`i connect ${slug}`)

      const connected = await integrations([
        "connect",
        slug,
        "--credential-env",
        "ACCEPTANCE_TOKEN"
      ])
      expect(connected.exitCode, connected.stderr).toBe(0)
      // The credential was read from this process's environment and handed to
      // the gateway; it is never echoed back.
      expect(connected.stdout).not.toContain("acceptance-secret")

      const tools = await integrations(["tools", slug])
      expect(tools.exitCode, tools.stderr).toBe(0)
      expect(tools.stdout).toContain("tickets.create")

      const schema = await integrations(["schema", slug, "tickets.create"])
      expect(schema.exitCode, schema.stderr).toBe(0)
      expect(schema.stdout).toContain("title")

      const listed = parseOutput(ConnectionsOutput, (await integrations(["connections"])).stdout)
      const address = listed.connections[0]?.address ?? ""
      expect(address).toStartWith(`tools.${slug}.org.`)

      const executed = await integrations([
        "execute",
        slug.replace(/[^a-z0-9]+/g, "-"),
        "tickets.create",
        JSON.stringify({ body: { title: "Connected" } })
      ])
      expect(executed.exitCode, executed.stderr).toBe(0)
      expect(vendor.invocations()).toBe(1)
    },
    30_000
  )

  test("a delegated key reaches only what it was granted", async () => {
    const vendor = startVendor()
    const gateway = await startGateway()
    await loginOperator(gateway)
    const clientCli = (args: ReadonlyArray<string>, environment = gateway.environment) =>
      run(agentCli, args, environment)
    const operator = (args: ReadonlyArray<string>) =>
      run(operatorCli, args, { ...gateway.environment, INTEGRATIONS_API_KEY: undefined })

    const discovered = parseOutput(DiscoveredOutput, (await clientCli(["discover", vendor.specUrl])).stdout)
    const slug = discovered.integration.slug
    await clientCli(["connect", slug, "--credential-env", "ACCEPTANCE_TOKEN"])
    const operatorCatalog = await operator(["integrations"])
    expect(operatorCatalog.exitCode, operatorCatalog.stderr).toBe(0)

    const client = parseOutput(IdOutput, (await operator(["client", "sandbox"])).stdout)
    const key = parseOutput(SecretOutput, (await operator(["key", client.id])).stdout)
    const sandbox = {
      ...gateway.environment,
      INTEGRATIONS_API_KEY: key.secret
    }

    // A sandbox key cannot mint capabilities for itself.
    const escalation = await clientCli(["client", "escalated"], sandbox)
    expect(escalation.exitCode).toBe(1)
    // Says what was refused and what would fix it, because a capability
    // refusal is fixed with a different key rather than a different request.
    expect(escalation.stderr).toContain("Unknown subcommand")

    const discoverAttempt = await clientCli(["discover", vendor.specUrl], sandbox)
    expect(discoverAttempt.exitCode).toBe(1)
    expect(discoverAttempt.stderr).toContain("required capability")

    await operator([
      "grant",
      client.id,
      "tickets",
      "tickets.create",
      "--integration",
      slug,
      "--allow"
    ])

    const executed = await clientCli([
      "execute",
      "tickets",
      "tickets.create",
      JSON.stringify({ body: { title: "Delegated" } })
    ], sandbox)
    expect(executed.exitCode, executed.stderr).toBe(0)
    expect(executed.stdout).toContain("succeeded")
    expect(vendor.seenKeys()).toEqual(["acceptance-secret"])

    // An ungranted tool on a granted alias is refused.
    const refused = await clientCli([
      "execute",
      "tickets",
      "tickets.delete",
      "{}"
    ], sandbox)
    expect(refused.exitCode).toBe(1)
  }, 30_000)

  test("every result is JSON a reader can parse, whole", async () => {
    const vendor = startVendor()
    const gateway = await startGateway()
    await loginOperator(gateway)
    const clientCli = (args: ReadonlyArray<string>, environment = gateway.environment) =>
      run(agentCli, args, environment)
    const operator = (args: ReadonlyArray<string>) =>
      run(operatorCli, args, { ...gateway.environment, INTEGRATIONS_API_KEY: undefined })

    const discovered = parseOutput(DiscoveredOutput, (await clientCli(["discover", vendor.specUrl])).stdout)
    const slug = discovered.integration.slug
    await clientCli(["connect", slug, "--credential-env", "ACCEPTANCE_TOKEN"])

    // A tool result is the machine-facing payload. Cutting the document to
    // save tokens does not make it a smaller answer, it makes it unusable, so
    // the default output has to parse.
    const direct = await operator([
      "execute",
      "--direct",
      `tools.${slug}.org.default.tickets.create`,
      JSON.stringify({ body: { title: "x".repeat(2000) } })
    ])
    expect(direct.exitCode, direct.stderr).toBe(0)
    const outcome = parseOutput(DirectOutcome, direct.stdout)
    expect(outcome.status).toBe("succeeded")
    expect(outcome.result.title).toHaveLength(2000)

    // A refusal is an answer, and it arrives as one: parseable, with a
    // non-zero exit code to say which answer it was.
    const client = parseOutput(IdOutput, (await operator(["client", "sandbox"])).stdout)
    const key = parseOutput(SecretOutput, (await operator(["key", client.id])).stdout)
    const refused = await clientCli(
      ["execute", "nothing", "tickets.create", "{}"],
      { ...gateway.environment, INTEGRATIONS_API_KEY: key.secret }
    )
    expect(refused.exitCode).toBe(1)
    expect(JSON.parse(refused.stdout)).toHaveProperty("status", "denied")
  }, 40_000)

  test("listings return every row, and window only when asked", async () => {
    const vendor = startVendor()
    const gateway = await startGateway()
    const integrations = (args: ReadonlyArray<string>) =>
      run(agentCli, args, gateway.environment)

    const discovered = parseOutput(DiscoveredOutput, (await integrations(["discover", vendor.specUrl])).stdout)
    const slug = discovered.integration.slug
    await integrations(["connect", slug, "--credential-env", "ACCEPTANCE_TOKEN"])

    const whole = parseOutput(ToolsOutput, (await integrations(["tools", slug])).stdout)
    // Nothing is held back behind a flag the reader did not know to pass.
    expect(whole.tools).toHaveLength(whole.count)
    expect(whole.showing).toBeUndefined()

    const windowed = parseOutput(
      WindowedToolsOutput,
      (await integrations(["tools", slug, "--limit", "1", "--offset", "0"])).stdout
    )
    expect(windowed.tools).toHaveLength(1)
    expect(windowed.showing).toBe(1)
    expect(windowed.count).toBe(whole.count)

    const catalog = parseOutput(CountOutput, (await integrations(["integrations"])).stdout)
    expect(catalog.count).toBeGreaterThan(0)
  }, 40_000)

  test("a grant can be revoked, and a key listed and revoked, from the CLI", async () => {
    const vendor = startVendor()
    const gateway = await startGateway()
    await loginOperator(gateway)
    const clientCli = (args: ReadonlyArray<string>, environment = gateway.environment) =>
      run(agentCli, args, environment)
    const operator = (args: ReadonlyArray<string>) =>
      run(operatorCli, args, { ...gateway.environment, INTEGRATIONS_API_KEY: undefined })

    const discovered = parseOutput(DiscoveredOutput, (await clientCli(["discover", vendor.specUrl])).stdout)
    const slug = discovered.integration.slug
    await clientCli(["connect", slug, "--credential-env", "ACCEPTANCE_TOKEN"])
    const client = parseOutput(IdOutput, (await operator(["client", "sandbox"])).stdout)
    const key = parseOutput(KeyOutput, (await operator(["key", client.id])).stdout)
    const sandbox = { ...gateway.environment, INTEGRATIONS_API_KEY: key.secret }
    const grant = parseOutput(IdOutput, (await operator([
      "grant",
      client.id,
      "tickets",
      "tickets.create",
      "--integration",
      slug
    ])).stdout)

    const keys = parseOutput(KeysOutput, (await operator(["keys", client.id])).stdout)
    expect(keys.keys.map((entry) => entry.id)).toEqual([key.id])

    // Undoing a delegation was the one thing the CLI could not do.
    const revokedGrant = await operator(["revoke", "grant", grant.id])
    expect(revokedGrant.exitCode, revokedGrant.stderr).toBe(0)
    const afterRevoke = await clientCli([
      "execute",
      "tickets",
      "tickets.create",
      JSON.stringify({ body: { title: "Revoked" } })
    ], sandbox)
    expect(afterRevoke.exitCode).toBe(1)

    const revokedKey = await operator(["revoke", "key", key.id])
    expect(revokedKey.exitCode, revokedKey.stderr).toBe(0)
    const withRevokedKey = await clientCli([
      "execute",
      "tickets",
      "tickets.create",
      JSON.stringify({ body: { title: "Revoked key" } })
    ], sandbox)
    expect(withRevokedKey.exitCode).toBe(1)
  }, 40_000)
})
