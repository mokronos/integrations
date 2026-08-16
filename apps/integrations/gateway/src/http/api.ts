import { Schema } from "effect"
import type { ExecutorServices } from "@mokronos/wfkit-executor"
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

export const makeRoutes = (dependencies: ApiDependencies): ReadonlyArray<Route> => {
  const { store, executor, retentionDays } = dependencies

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
      path: "/v1/connections",
      access: "privileged",
      handle: async () => ok({ connections: await executor.connections.list() })
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
