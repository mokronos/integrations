import { Schema } from "effect"
import type { ExecutorServices } from "@mokronos/wfkit-executor"
import { searchIntegrations } from "@mokronos/wfkit-executor"
import { ExecutorToolAddress } from "@mokronos/wfkit-executor/schemas"
import type { OAuthSessions } from "../oauth-sessions.ts"
import {
  Alias,
  ApprovalId,
  ClientId,
  ConnectionName,
  GrantId,
  IntegrationSlug,
  SubjectId,
  ToolName
} from "../domain.ts"
import type { ConnectionRef } from "../domain.ts"
import { executeAuthorized, invokeThroughGateway, listGrantedTools } from "../invoke.ts"
import { generateApiKey, newClientId, newGrantId } from "../keys.ts"
import type { GatewayStore } from "../store.ts"
import { badRequest, created, decodeBody, notFound, ok } from "./router.ts"
import type { Route } from "./router.ts"

export interface ApiDependencies {
  readonly store: GatewayStore
  readonly executor: ExecutorServices
  readonly retentionDays: number
  readonly oauth: OAuthSessions
}

// --- wire schemas -----------------------------------------------------------

const ExecuteBody = Schema.Struct({
  alias: Schema.String,
  tool: Schema.String,
  arguments: Schema.optional(Schema.Json)
})

const ConnectionRefBody = Schema.Union([
  Schema.Struct({
    owner: Schema.Literal("org"),
    integration: Schema.String,
    name: Schema.String
  }),
  Schema.Struct({
    owner: Schema.Literal("user"),
    subject: Schema.String,
    integration: Schema.String,
    name: Schema.String
  })
])

const CreateClientBody = Schema.Struct({
  name: Schema.String,
  mayMutate: Schema.optional(Schema.Boolean)
})

const CreateGrantBody = Schema.Struct({
  clientId: Schema.String,
  alias: Schema.String,
  tool: Schema.String,
  connection: ConnectionRefBody,
  decision: Schema.optional(Schema.Literals(["allow", "require_approval"]))
})

const DecideApprovalBody = Schema.Struct({
  decidedBy: Schema.optional(Schema.String)
})

const DiscoverBody = Schema.Struct({
  url: Schema.String,
  connection: Schema.optional(Schema.String)
})

const ConnectBody = Schema.Struct({
  integration: Schema.String,
  connection: Schema.optional(Schema.String),
  template: Schema.optional(Schema.String),
  /** Credential values, resolved from the environment by the *client* before
   *  they get here. The gateway never reads a caller's environment. */
  values: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

const OAuthStartBody = Schema.Struct({
  integration: Schema.String,
  connection: Schema.optional(Schema.String),
  template: Schema.optional(Schema.String),
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  timeoutSeconds: Schema.optional(Schema.Number)
})

const InvokeAddressBody = Schema.Struct({
  address: Schema.String,
  arguments: Schema.optional(Schema.Json)
})

const ValidateBody = Schema.Struct({
  node: Schema.Json,
  live: Schema.optional(Schema.Boolean)
})

const toConnectionRef = (value: typeof ConnectionRefBody.Type): ConnectionRef =>
  value.owner === "org"
    ? {
      owner: "org",
      integration: IntegrationSlug.make(value.integration),
      name: ConnectionName.make(value.name)
    }
    : {
      owner: "user",
      subject: SubjectId.make(value.subject),
      integration: IntegrationSlug.make(value.integration),
      name: ConnectionName.make(value.name)
    }

const parseAlias = (value: string): Alias => {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new Error(`Alias "${value}" must be lowercase letters, digits, and dashes`)
  }
  return Alias.make(value)
}

const positiveInt = (value: string | null, fallback: number): number => {
  if (value === null) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// --- routes -----------------------------------------------------------------

/** Picks the auth method a connect request should use, preferring an explicit
 *  template and otherwise the integration's only sensible option. */
const selectAuthMethod = (
  methods: ReadonlyArray<{ readonly id: string; readonly template: string; readonly kind: string }>,
  template: string | undefined
) => {
  if (template !== undefined) {
    const chosen = methods.find((method) => method.template === template || method.id === template)
    if (chosen === undefined) {
      throw new Error(
        `Unknown auth template "${template}". Available: ${methods.map((m) => m.template).join(", ")}`
      )
    }
    return chosen
  }
  if (methods.length === 0) return { id: "none", template: "none", kind: "none" }
  if (methods.length === 1) return methods[0]!
  const single = methods.find((method) => method.kind === "oauth") ?? methods[0]!
  return single
}

export const makeRoutes = (dependencies: ApiDependencies): ReadonlyArray<Route> => {
  const { store, executor, retentionDays, oauth } = dependencies

  return [
    // --- delegated: any live key -------------------------------------------
    {
      method: "GET",
      path: "/v1/tools",
      access: "delegated",
      handle: async (request) => ok({ tools: await listGrantedTools(store, request.client.id) })
    },
    {
      method: "POST",
      path: "/v1/execute",
      access: "delegated",
      handle: async (request) => {
        const body = decodeBody(ExecuteBody, request.body)
        const outcome = await invokeThroughGateway(
          { store, executor, argumentRetentionDays: retentionDays },
          {
            secret: request.secret,
            alias: parseAlias(body.alias),
            tool: ToolName.make(body.tool),
            arguments: body.arguments ?? {}
          }
        )
        // A frozen call is not an error: the caller gets an identifier to poll,
        // and its branch of work suspends rather than failing.
        if (outcome.status === "denied") return { status: 403, body: outcome }
        if (outcome.status === "failed") return { status: 502, body: outcome }
        return ok(outcome)
      }
    },
    {
      method: "GET",
      path: "/v1/approvals/:id",
      access: "delegated",
      handle: async (request) => {
        const id = ApprovalId.make(request.params["id"] ?? "")
        const approval = await store.getApproval(id)
        if (approval === undefined) return notFound(`Unknown approval ${id}`)
        // Scoped to the caller: one client must not read another's frozen call.
        if (approval.clientId !== request.client.id) return notFound(`Unknown approval ${id}`)
        return ok(approval)
      }
    },

    // --- privileged: catalog and connections --------------------------------
    {
      method: "GET",
      path: "/v1/integrations",
      access: "privileged",
      handle: async () => ok({ integrations: await executor.listIntegrationOverviews() })
    },
    {
      method: "POST",
      path: "/v1/integrations/discover",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(DiscoverBody, request.body)
        const result = await executor.provisioning.provision(
          body.url,
          body.connection === undefined ? {} : { connection: body.connection }
        )
        return created(result)
      }
    },
    {
      method: "GET",
      path: "/v1/integrations/:slug/tools",
      access: "privileged",
      handle: async (request) => ok({
        tools: await executor.tools.summaries({ integration: request.params["slug"] ?? "" })
      })
    },
    {
      method: "GET",
      path: "/v1/integrations/:slug/tools/:tool",
      access: "privileged",
      handle: async (request) => {
        const connection = request.query.get("connection")
        const tool = await executor.tools.describe({
          integration: request.params["slug"] ?? "",
          name: request.params["tool"] ?? "",
          ...(connection === null ? {} : { connection })
        })
        return ok(tool)
      }
    },
    {
      method: "GET",
      path: "/v1/registry/search",
      access: "privileged",
      handle: async (request) => {
        const query = request.query.get("q")
        if (query === null) return badRequest("search requires a q query parameter")
        const kind = request.query.get("kind")
        return ok(await searchIntegrations({
          q: query,
          limit: positiveInt(request.query.get("limit"), 5),
          ...(kind === null
            ? {}
            : {
              kind: Schema.decodeUnknownSync(
                Schema.Literals(["mcp", "openapi", "graphql", "cli"])
              )(kind)
            })
        }))
      }
    },
    {
      method: "POST",
      path: "/v1/tools/invoke",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(InvokeAddressBody, request.body)
        // Privileged, and deliberately not grant-checked: a client that may
        // mutate grants could grant itself this tool in one extra call, so a
        // check here would be friction rather than a control. The delegated
        // surface has no address form at all. See docs/adr/0002.
        const result = await executor.tools.execute(
          ExecutorToolAddress.make(body.address),
          body.arguments ?? {}
        )
        return ok(result)
      }
    },
    {
      method: "POST",
      path: "/v1/validate",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(ValidateBody, request.body)
        return ok(await executor.validateIntegrationNode(body.node, { live: body.live ?? false }))
      }
    },
    {
      method: "GET",
      path: "/v1/connections",
      access: "privileged",
      handle: async () => ok({ connections: await executor.connections.list() })
    },
    {
      method: "POST",
      path: "/v1/connections",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(ConnectBody, request.body)
        const integration = await executor.catalog.find(body.integration)
        if (integration === undefined) return notFound(`Unknown integration ${body.integration}`)
        const method = selectAuthMethod(integration.authMethods, body.template)
        if (method.kind === "oauth") {
          return badRequest(
            `${integration.slug} uses OAuth; start it at POST /v1/connections/oauth`
          )
        }
        const values = body.values ?? {}
        const names = Object.keys(values)
        const connection = await executor.connections.create({
          integration: integration.slug,
          name: body.connection ?? "default",
          template: method.template,
          ...(names.length === 0
            ? { value: "" }
            : names.length === 1 && values["token"] !== undefined
            ? { value: values["token"] }
            : { values })
        })
        return created({
          connection,
          tools: await executor.tools.summaries({
            integration: integration.slug,
            connection: connection.name
          })
        })
      }
    },
    {
      method: "POST",
      path: "/v1/connections/oauth",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(OAuthStartBody, request.body)
        const integration = await executor.catalog.find(body.integration)
        if (integration === undefined) return notFound(`Unknown integration ${body.integration}`)
        const method = integration.authMethods.find((candidate) =>
          body.template === undefined
            ? candidate.kind === "oauth"
            : candidate.template === body.template || candidate.id === body.template
        )
        if (method === undefined || method.kind !== "oauth") {
          return badRequest(`${integration.slug} has no OAuth auth method`)
        }
        // The gateway drives the flow and hosts the callback, because it is
        // what holds credentials. The caller opens a browser and polls.
        const session = await oauth.start({
          integration: integration.slug,
          connection: body.connection ?? "default",
          authMethod: method,
          ...(body.clientId === undefined ? {} : { clientId: body.clientId }),
          ...(body.clientSecret === undefined ? {} : { clientSecret: body.clientSecret }),
          ...(body.timeoutSeconds === undefined
            ? {}
            : { timeoutMs: Math.max(1, body.timeoutSeconds) * 1000 })
        })
        return created(session)
      }
    },
    {
      method: "GET",
      path: "/v1/connections/oauth/:id",
      access: "privileged",
      handle: async (request) => {
        const session = oauth.get(request.params["id"] ?? "")
        if (session === undefined) return notFound("Unknown or expired OAuth session")
        return ok(session)
      }
    },
    {
      method: "DELETE",
      path: "/v1/connections/:integration/:name",
      access: "privileged",
      handle: async (request) => {
        await executor.connections.remove({
          integration: request.params["integration"] ?? "",
          name: request.params["name"] ?? ""
        })
        return ok({ removed: true })
      }
    },

    // --- privileged: clients, keys, grants ----------------------------------
    {
      method: "GET",
      path: "/v1/clients",
      access: "privileged",
      handle: async () => ok({ clients: await store.listClients() })
    },
    {
      method: "POST",
      path: "/v1/clients",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(CreateClientBody, request.body)
        if (await store.findClientByName(body.name) !== undefined) {
          return badRequest(`A client named ${body.name} already exists`)
        }
        const client = await store.createClient({
          id: newClientId(),
          name: body.name,
          mayMutate: body.mayMutate ?? false
        })
        return created(client)
      }
    },
    {
      method: "POST",
      path: "/v1/clients/:id/keys",
      access: "privileged",
      handle: async (request) => {
        const clientId = ClientId.make(request.params["id"] ?? "")
        if (await store.findClientById(clientId) === undefined) {
          return notFound(`Unknown client ${clientId}`)
        }
        const key = generateApiKey()
        await store.addApiKey({ id: key.id, clientId, hash: key.hash })
        // The only time the plaintext exists outside the caller's hands.
        return created({ id: key.id, clientId, secret: key.secret })
      }
    },
    {
      method: "POST",
      path: "/v1/clients/:id/revoke",
      access: "privileged",
      handle: async (request) => {
        const clientId = ClientId.make(request.params["id"] ?? "")
        if (await store.findClientById(clientId) === undefined) {
          return notFound(`Unknown client ${clientId}`)
        }
        await store.revokeClient(clientId)
        // Revoking a client is done because something is wrong, so its frozen
        // actions must not stay armed. Revoking a single key does not do this.
        const cancelled = await store.cancelApprovalsForClient(clientId)
        return ok({ revoked: true, cancelledApprovals: cancelled })
      }
    },
    {
      method: "GET",
      path: "/v1/grants",
      access: "privileged",
      handle: async (request) => {
        const clientId = request.query.get("clientId")
        if (clientId === null) return badRequest("grants require a clientId query parameter")
        return ok({ grants: await store.listGrants(ClientId.make(clientId)) })
      }
    },
    {
      method: "POST",
      path: "/v1/grants",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(CreateGrantBody, request.body)
        const clientId = ClientId.make(body.clientId)
        if (await store.findClientById(clientId) === undefined) {
          return notFound(`Unknown client ${clientId}`)
        }
        const grant = await store.createGrant({
          id: newGrantId(),
          clientId,
          alias: parseAlias(body.alias),
          tool: ToolName.make(body.tool),
          connection: toConnectionRef(body.connection),
          decision: body.decision ?? "allow"
        })
        return created(grant)
      }
    },
    {
      method: "POST",
      path: "/v1/grants/:id/revoke",
      access: "privileged",
      handle: async (request) => {
        await store.revokeGrant(GrantId.make(request.params["id"] ?? ""))
        return ok({ revoked: true })
      }
    },

    // --- privileged: approvals, audit ---------------------------------------
    {
      method: "GET",
      path: "/v1/approvals",
      access: "privileged",
      handle: async (request) => {
        const status = request.query.get("status")
        return ok({
          approvals: status === null
            ? await store.listApprovals()
            : await store.listApprovals(
              Schema.decodeUnknownSync(
                Schema.Literals(["pending", "approved", "denied", "expired"])
              )(status)
            )
        })
      }
    },
    {
      method: "POST",
      path: "/v1/approvals/:id/approve",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(DecideApprovalBody, request.body ?? {})
        const id = ApprovalId.make(request.params["id"] ?? "")
        const approval = await store.getApproval(id)
        if (approval === undefined) return notFound(`Unknown approval ${id}`)
        if (approval.status !== "pending") {
          return badRequest(`Approval ${id} is already ${approval.status}`)
        }
        if (approval.expiresAt.getTime() <= Date.now()) {
          await store.settleApproval({
            id,
            status: "expired",
            decidedBy: null,
            result: null,
            error: "expired before a decision was recorded"
          })
          // Expiry is a decision, not an absence of one.
          return badRequest(`Approval ${id} expired`)
        }

        const client = await store.findClientById(approval.clientId)
        const grants = await store.listGrants(approval.clientId)
        const grant = grants.find((candidate) => candidate.id === approval.grantId)
        if (client === undefined || client.revokedAt !== null || grant === undefined) {
          await store.settleApproval({
            id,
            status: "denied",
            decidedBy: body.decidedBy ?? null,
            result: null,
            error: "the client or grant was revoked while this call was frozen"
          })
          return badRequest(`Approval ${id} is no longer authorized`)
        }

        // The gateway performs the call. The caller is never handed the ability
        // to perform it, so approving confers no capability.
        const outcome = await executeAuthorized(
          { store, executor, retentionDays },
          {
            status: "authorized",
            client,
            grant,
            connection: grant.connection,
            subject: grant.connection.owner === "user" ? grant.connection.subject : null
          },
          approval.arguments
        )
        await store.settleApproval({
          id,
          status: "approved",
          decidedBy: body.decidedBy ?? null,
          result: outcome.status === "succeeded" ? outcome.result : null,
          error: outcome.status === "failed" ? outcome.message : null
        })
        return ok({ approval: await store.getApproval(id), outcome })
      }
    },
    {
      method: "POST",
      path: "/v1/approvals/:id/deny",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(DecideApprovalBody, request.body ?? {})
        const id = ApprovalId.make(request.params["id"] ?? "")
        const approval = await store.getApproval(id)
        if (approval === undefined) return notFound(`Unknown approval ${id}`)
        await store.settleApproval({
          id,
          status: "denied",
          decidedBy: body.decidedBy ?? null,
          result: null,
          error: null
        })
        return ok({ approval: await store.getApproval(id) })
      }
    },
    {
      method: "GET",
      path: "/v1/audit",
      access: "privileged",
      handle: async (request) => ok({
        records: await store.listAudit(positiveInt(request.query.get("limit"), 50))
      })
    }
  ]
}
