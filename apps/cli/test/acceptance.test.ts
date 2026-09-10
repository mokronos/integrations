import path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { serveGateway } from "@mokronos/integrations"
import { aliasForConnection, ConnectionName, IntegrationSlug } from "@integrations/gateway-core"
import { temporaryDirectory, testServices } from "./fixtures.ts"

const services = Layer.merge(testServices, FetchHttpClient.layer)

const repoRoot = path.resolve(import.meta.dirname, "../../..")
const agentCli = path.join(repoRoot, "apps", "cli", "src", "agent.ts")
const operatorCli = path.join(repoRoot, "apps", "cli", "src", "main.ts")

const parseOutput = <A>(schema: Schema.Codec<A>, text: string): A =>
  Schema.decodeUnknownSync(schema)(JSON.parse(text))

const orgAlias = (integration: string, name: string): string =>
  aliasForConnection({
    owner: "org",
    integration: IntegrationSlug.make(integration),
    name: ConnectionName.make(name)
  })

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

/** A CLI invocation, as a shell would make it. */
const run = (
  cli: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>>
) =>
  Effect.promise(async () => {
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
  })

/** The vendor a discovered integration points at, stopped with the test's scope. */
const startVendor = Effect.acquireRelease(
  Effect.sync(() => {
    let invocations = 0
    const seenKeys: Array<string | null> = []
    const server: ReturnType<typeof Bun.serve> = Bun.serve({
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
    return {
      server,
      specUrl: `http://127.0.0.1:${server.port}/openapi.json`,
      registryUrl: `http://127.0.0.1:${server.port}`,
      invocations: () => invocations,
      seenKeys: () => seenKeys
    }
  }),
  (vendor) => Effect.promise(() => vendor.server.stop(true))
)

/** A gateway serving on a loopback port, stopped with the test's scope. */
const startGateway = Effect.fnUntraced(function*(registryUrl?: string) {
  const home = yield* temporaryDirectory("integrations-acceptance-")
  const gateway = yield* Effect.acquireRelease(
    Effect.promise(() =>
      registryUrl === undefined
        ? serveGateway({ home, port: 0, httpClient: FetchHttpClient.layer })
        : serveGateway({ home, port: 0, registryUrl, httpClient: FetchHttpClient.layer })),
    (running) => Effect.promise(() => running.stop())
  )
  const config = yield* Effect.promise(() => Bun.file(path.join(home, "gateway.json")).text())
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
})

/** A gateway reachable off loopback, as a deployed one would be. */
const startRemoteGateway = Effect.fnUntraced(function*() {
  const serverHome = yield* temporaryDirectory("integrations-remote-server-")
  const clientHome = yield* temporaryDirectory("integrations-remote-client-")
  const gateway = yield* Effect.acquireRelease(
    Effect.promise(() =>
      serveGateway({
        httpClient: FetchHttpClient.layer,
        home: serverHome,
        hostname: "0.0.0.0",
        port: 0,
        publicUrl: "https://gateway.example"
      })),
    (running) => Effect.promise(() => running.stop())
  )
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
})

const loginOperator = Effect.fnUntraced(function*(
  gateway: { readonly environment: Readonly<Record<string, string | undefined>> }
) {
  const signedUp = yield* run(operatorCli, [
    "signup",
    "--password",
    "correct horse battery",
    "operator@example.com"
  ], gateway.environment)
  expect(`signup exit ${signedUp.exitCode}: ${signedUp.stderr}`).toBe("signup exit 0: ")
})

describe("integrations CLI acceptance", () => {
  it.live("a remote ii uses a login session while i uses only its delegated API key", () =>
    Effect.gen(function*() {
      const gateway = yield* startRemoteGateway()
      const operator = (args: ReadonlyArray<string>) =>
        run(operatorCli, args, gateway.environment)

      const signedUp = yield* operator([
        "signup",
        "--password",
        "correct horse battery",
        "remote@example.com"
      ])
      expect(signedUp.exitCode, signedUp.stderr).toBe(0)

      const catalog = yield* operator(["integrations"])
      expect(catalog.exitCode, catalog.stderr).toBe(0)

      const login = yield* (HttpClient.execute(HttpClientRequest.setBody(
        HttpClientRequest.post(`${gateway.url}/v1/auth/login`),
        HttpBody.jsonUnsafe({
          email: "remote@example.com",
          password: "correct horse battery"
        })
      )))
      expect(login.status).toBe(200)
      const setCookie = login.headers["set-cookie"] ?? ""
      expect(setCookie).toContain("Secure")
      const cookie = setCookie.split(";", 1)[0] ?? ""
      const remoteCatalogResponse = yield* (HttpClient.get(`${gateway.url}/v1/integrations`, {
        headers: { cookie }
      }))
      expect(remoteCatalogResponse.status).toBe(200)
      const remoteCatalog = Schema.decodeUnknownSync(CatalogOutput)(
        yield* (remoteCatalogResponse.json)
      )
      expect(remoteCatalog.oauthCallbackUrl).toBe(
        "https://gateway.example/v1/oauth/callback"
      )

      const client = parseOutput(
        IdOutput,
        (yield* operator(["client", "remote-agent", "--provision"])).stdout
      )
      const key = parseOutput(SecretOutput, (yield* operator(["key", client.id])).stdout)
      const agentEnvironment = {
        ...gateway.environment,
        INTEGRATIONS_API_KEY: key.secret
      }
      const connections = yield* run(agentCli, ["connections"], agentEnvironment)
      expect(connections.exitCode, connections.stderr).toBe(0)
      expect(parseOutput(ConnectionsOutput, connections.stdout).connections).toEqual([])

      const administrative = yield* run(agentCli, ["clients"], agentEnvironment)
      expect(administrative.exitCode).not.toBe(0)
      expect(administrative.stderr).toContain("Unknown subcommand")

      expect((yield* operator(["logout"])).exitCode).toBe(0)
      const afterLogout = yield* operator(["clients"])
      expect(afterLogout.exitCode).not.toBe(0)
      expect(afterLogout.stderr).toContain("No operator credential found")
    }).pipe(Effect.provide(services)), 40_000)

  it.live("ii signs a human out and back in without an API key", () =>
    Effect.gen(function*() {
      const gateway = yield* startGateway()
      yield* loginOperator(gateway)
      const environment = { ...gateway.environment, INTEGRATIONS_API_KEY: undefined }
      const operator = (args: ReadonlyArray<string>) => run(operatorCli, args, environment)

      const signedIn = parseOutput(AuthenticationOutput, (yield* operator(["whoami"])).stdout)
      expect(signedIn).toEqual({ authenticated: true, email: "operator@example.com" })

      const logout = yield* operator(["logout"])
      expect(logout.exitCode, logout.stderr).toBe(0)
      const signedOut = parseOutput(AuthenticationOutput, (yield* operator(["whoami"])).stdout)
      expect(signedOut).toEqual({ authenticated: false })

      const login = yield* operator([
        "login",
        "--password",
        "correct horse battery",
        "operator@example.com"
      ])
      expect(login.exitCode, login.stderr).toBe(0)
      const signedInAgain = parseOutput(AuthenticationOutput, (yield* operator(["whoami"])).stdout)
      expect(signedInAgain).toEqual({ authenticated: true, email: "operator@example.com" })
    }).pipe(Effect.provide(services)), 30_000)

  it.live("an agent searches, discovers, connects, inspects, and invokes a connection — all through the gateway", () =>
    Effect.gen(function*() {
        const vendor = yield* startVendor
        const gateway = yield* startGateway(vendor.registryUrl)
        const integrations = (args: ReadonlyArray<string>) =>
          run(agentCli, args, gateway.environment)

        const searched = yield* integrations(["search", "acceptance tickets"])
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

        const discovered = yield* integrations(["discover", discoveryUrl ?? ""])
        expect(discovered.exitCode, discovered.stderr).toBe(0)
        const DiscoverBody = Schema.Struct({
          integration: Schema.Struct({ slug: Schema.String }),
          next: Schema.String
        })
        const discoveredBody = Schema.decodeUnknownSync(DiscoverBody)(
          JSON.parse(discovered.stdout)
        )
        const slug = discoveredBody.integration.slug
        expect(discoveredBody.next).toBe(`i connect ${slug}`)

        const connected = yield* integrations([
          "connect",
          slug,
          "--credential-env",
          "ACCEPTANCE_TOKEN"
        ])
        expect(connected.exitCode, connected.stderr).toBe(0)
        expect(connected.stdout).not.toContain("acceptance-secret")

        const tools = yield* integrations(["tools", slug])
        expect(tools.exitCode, tools.stderr).toBe(0)
        expect(tools.stdout).toContain("tickets.create")

        const schema = yield* integrations(["schema", slug, "tickets.create"])
        expect(schema.exitCode, schema.stderr).toBe(0)
        expect(schema.stdout).toContain("title")

        const listed = parseOutput(ConnectionsOutput, (yield* integrations(["connections"])).stdout)
        const address = listed.connections[0]?.address ?? ""
        const connectionName = listed.connections[0]?.name ?? ""
        expect(address).toMatch(new RegExp(`^tools\\.${slug}\\.org\\.`))

        yield* loginOperator(gateway)
        const operator = (args: ReadonlyArray<string>) =>
          run(operatorCli, args, { ...gateway.environment, INTEGRATIONS_API_KEY: undefined })
        const client = parseOutput(IdOutput, (yield* operator(["client", "acceptance-agent"])).stdout)
        const accessProfile = parseOutput(
          IdOutput,
          (yield* operator(["access-profile", "acceptance-access"])).stdout
        )
        const included = yield* operator([
          "access-profile-tool", accessProfile.id, slug, "tickets.create",
          "--connection", connectionName
        ])
        expect(included.exitCode, included.stderr).toBe(0)
        const assignedAccess = yield* operator([
          "assign-access-profile", client.id, accessProfile.id
        ])
        expect(assignedAccess.exitCode, assignedAccess.stderr).toBe(0)
        const approvalPolicy = parseOutput(
          IdOutput,
          (yield* operator(["approval-policy", "acceptance-approval"])).stdout
        )
        const decided = yield* operator([
          "approval-policy-tool", approvalPolicy.id, slug, "tickets.create", "require-approval",
          "--connection", connectionName
        ])
        expect(decided.exitCode, decided.stderr).toBe(0)
        const assignedApproval = yield* operator([
          "assign-approval-policy", client.id, approvalPolicy.id
        ])
        expect(assignedApproval.exitCode, assignedApproval.stderr).toBe(0)
        const key = parseOutput(SecretOutput, (yield* operator(["key", client.id])).stdout)

        const executed = yield* run(agentCli, [
          "execute",
          orgAlias(slug, connectionName),
          "tickets.create",
          JSON.stringify({ body: { title: "Connected" } })
        ], { ...gateway.environment, INTEGRATIONS_API_KEY: key.secret })
        expect(executed.exitCode, executed.stderr).toBe(0)
        expect(executed.stdout).toContain("pending")
        expect(vendor.invocations()).toBe(0)
    }).pipe(Effect.provide(services)), 30_000)

  it.live("a delegated key reaches only what its assigned access profile includes", () =>
    Effect.gen(function*() {
      const vendor = yield* startVendor
      const gateway = yield* startGateway()
      yield* loginOperator(gateway)
      const clientCli = (args: ReadonlyArray<string>, environment = gateway.environment) =>
        run(agentCli, args, environment)
      const operator = (args: ReadonlyArray<string>) =>
        run(operatorCli, args, { ...gateway.environment, INTEGRATIONS_API_KEY: undefined })

      const discovered = parseOutput(DiscoveredOutput, (yield* clientCli(["discover", vendor.specUrl])).stdout)
      const slug = discovered.integration.slug
      yield* clientCli(["connect", slug, "--credential-env", "ACCEPTANCE_TOKEN"])
      const connections = parseOutput(ConnectionsOutput, (yield* clientCli(["connections"])).stdout)
      const connectionName = connections.connections[0]?.name ?? ""
      const operatorCatalog = yield* operator(["integrations"])
      expect(operatorCatalog.exitCode, operatorCatalog.stderr).toBe(0)

      const client = parseOutput(IdOutput, (yield* operator(["client", "sandbox"])).stdout)
      const accessProfile = parseOutput(
        IdOutput,
        (yield* operator(["access-profile", "sandbox-access"])).stdout
      )
      const included = yield* operator([
        "access-profile-tool",
        accessProfile.id,
        slug,
        "tickets.create",
        "--connection",
        connectionName
      ])
      expect(included.exitCode, included.stderr).toBe(0)
      const assignedAccess = yield* operator(["assign-access-profile", client.id, accessProfile.id])
      expect(assignedAccess.exitCode, assignedAccess.stderr).toBe(0)
      const approvalPolicy = parseOutput(
        IdOutput,
        (yield* operator(["approval-policy", "sandbox-approval"])).stdout
      )
      const allowed = yield* operator([
        "approval-policy-tool", approvalPolicy.id, slug, "tickets.create", "allow",
        "--connection", connectionName
      ])
      expect(allowed.exitCode, allowed.stderr).toBe(0)
      const assignedApproval = yield* operator([
        "assign-approval-policy", client.id, approvalPolicy.id
      ])
      expect(assignedApproval.exitCode, assignedApproval.stderr).toBe(0)
      const key = parseOutput(SecretOutput, (yield* operator(["key", client.id])).stdout)
      const sandbox = {
        ...gateway.environment,
        INTEGRATIONS_API_KEY: key.secret
      }

      const escalation = yield* clientCli(["client", "escalated"], sandbox)
      expect(escalation.exitCode).toBe(1)
      expect(escalation.stderr).toContain("Unknown subcommand")

      const discoverAttempt = yield* clientCli(["discover", vendor.specUrl], sandbox)
      expect(discoverAttempt.exitCode).toBe(1)
      expect(discoverAttempt.stderr).toContain("required capability")

      const executed = yield* clientCli([
        "execute",
        orgAlias(slug, connectionName),
        "tickets.create",
        JSON.stringify({ body: { title: "Delegated" } })
      ], sandbox)
      expect(executed.exitCode, executed.stderr).toBe(0)
      expect(executed.stdout).toContain("succeeded")
      expect(vendor.seenKeys()).toEqual(["acceptance-secret"])

      const refused = yield* clientCli([
        "execute",
        orgAlias(slug, connectionName),
        "tickets.delete",
        "{}"
      ], sandbox)
      expect(refused.exitCode).toBe(1)
    }).pipe(Effect.provide(services)), 30_000)

  it.live("listings return every row, and window only when asked", () =>
    Effect.gen(function*() {
      const vendor = yield* startVendor
      const gateway = yield* startGateway()
      const integrations = (args: ReadonlyArray<string>) =>
        run(agentCli, args, gateway.environment)

      const discovered = parseOutput(DiscoveredOutput, (yield* integrations(["discover", vendor.specUrl])).stdout)
      const slug = discovered.integration.slug
      yield* integrations(["connect", slug, "--credential-env", "ACCEPTANCE_TOKEN"])

      const whole = parseOutput(ToolsOutput, (yield* integrations(["tools", slug])).stdout)
      expect(whole.tools).toHaveLength(whole.count)
      expect(whole.showing).toBeUndefined()

      const windowed = parseOutput(
        WindowedToolsOutput,
        (yield* integrations(["tools", slug, "--limit", "1", "--offset", "0"])).stdout
      )
      expect(windowed.tools).toHaveLength(1)
      expect(windowed.showing).toBe(1)
      expect(windowed.count).toBe(whole.count)

      const catalog = parseOutput(CountOutput, (yield* integrations(["integrations"])).stdout)
      expect(catalog.count).toBeGreaterThan(0)
    }).pipe(Effect.provide(services)), 40_000)

  it.live("an access profile can remove authority, and a key can be listed and revoked", () =>
    Effect.gen(function*() {
      const vendor = yield* startVendor
      const gateway = yield* startGateway()
      yield* loginOperator(gateway)
      const clientCli = (args: ReadonlyArray<string>, environment = gateway.environment) =>
        run(agentCli, args, environment)
      const operator = (args: ReadonlyArray<string>) =>
        run(operatorCli, args, { ...gateway.environment, INTEGRATIONS_API_KEY: undefined })

      const discovered = parseOutput(DiscoveredOutput, (yield* clientCli(["discover", vendor.specUrl])).stdout)
      const slug = discovered.integration.slug
      yield* clientCli(["connect", slug, "--credential-env", "ACCEPTANCE_TOKEN"])
      const connections = parseOutput(ConnectionsOutput, (yield* clientCli(["connections"])).stdout)
      const alias = orgAlias(slug, connections.connections[0]?.name ?? "")
      const client = parseOutput(IdOutput, (yield* operator(["client", "sandbox"])).stdout)
      const accessProfile = parseOutput(
        IdOutput,
        (yield* operator(["access-profile", "sandbox-access"])).stdout
      )
      yield* operator([
        "access-profile-tool", accessProfile.id, slug, "tickets.create",
        "--connection", connections.connections[0]?.name ?? ""
      ])
      yield* operator(["assign-access-profile", client.id, accessProfile.id])
      const key = parseOutput(KeyOutput, (yield* operator(["key", client.id])).stdout)
      const sandbox = { ...gateway.environment, INTEGRATIONS_API_KEY: key.secret }

      const keys = parseOutput(KeysOutput, (yield* operator(["keys", client.id])).stdout)
      expect(keys.keys.map((entry) => entry.id)).toEqual([key.id])

      const execute = (title: string) =>
        clientCli(
          ["execute", alias, "tickets.create", JSON.stringify({ body: { title } })],
          sandbox
        )

      // The profile reaches this tool, so the call gets past authorization and
      // is frozen by the conservative default policy rather than refused.
      const allowed = yield* execute("Allowed")
      expect(`allowed exit ${allowed.exitCode}: ${allowed.stderr}`).toBe("allowed exit 0: ")
      expect(JSON.parse(allowed.stdout)).toMatchObject({ status: "pending" })

      const emptyProfile = parseOutput(
        IdOutput,
        (yield* operator(["access-profile", "deny-all"])).stdout
      )
      const reassigned = yield* operator(["assign-access-profile", client.id, emptyProfile.id])
      expect(reassigned.exitCode, reassigned.stderr).toBe(0)

      const afterRevoke = yield* execute("Revoked")
      expect(afterRevoke.exitCode).toBe(1)
      expect(JSON.parse(afterRevoke.stdout)).toMatchObject({ status: "denied" })

      const revokedKey = yield* operator(["revoke", "key", key.id])
      expect(revokedKey.exitCode, revokedKey.stderr).toBe(0)

      const withRevokedKey = yield* execute("Revoked key")
      expect(withRevokedKey.exitCode).toBe(1)
      expect(vendor.invocations()).toBe(0)
    }).pipe(Effect.provide(services)), 40_000)
})
