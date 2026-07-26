import { auth, defineWorkflow, integration, t } from "@mokronos/wfkit"

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`Set ${name} before loading ConnectedCaseWorkflow`)
  return value
}

const apiUrl = requiredEnvironment("WF_CONNECTED_CASE_API_URL")
const mcpUrl = requiredEnvironment("WF_CONNECTED_CASE_MCP_URL")

const Customer = t.struct({ id: t.string, name: t.string, tier: t.string })
const Policy = t.struct({ tier: t.string, requiresApproval: t.boolean })
const CreatedCase = t.struct({ caseId: t.string, title: t.string })
const ApprovalAudit = t.struct({ auditId: t.string, caseId: t.string, approvedBy: t.string })

const lookupCustomer = integration({
  name: "LookupCustomer",
  source: {
    kind: "openapi",
    url: apiUrl,
    method: "GET",
    path: "/customers/{customerId}",
    spec: `${apiUrl}/openapi.json`,
    parameters: [
      { name: "customerId", in: "path" },
      { name: "include", in: "query" }
    ],
    headers: { "x-workflow-client": "connected-case-v1" }
  },
  operation: "getCustomer",
  input: t.struct({ customerId: t.string, include: t.string }),
  output: Customer,
  retry: { attempts: 3, backoff: "exponential" }
})

const lookupPolicy = integration({
  name: "LookupPolicy",
  source: {
    kind: "openapi",
    url: apiUrl,
    method: "GET",
    path: "/policies/{tier}",
    spec: `${apiUrl}/openapi.json`,
    parameters: [{ name: "tier", in: "path" }]
  },
  operation: "getPolicy",
  input: t.struct({ tier: t.string }),
  output: Policy
})

const createCase = integration({
  name: "CreateCase",
  source: { kind: "mcp", url: mcpUrl },
  operation: "create_case",
  auth: { kind: "bearer", credential: auth("case_manager_oauth") },
  input: t.struct({ customerId: t.string, title: t.string }),
  output: CreatedCase,
  retry: { attempts: 3, backoff: "exponential" }
})

const approveCase = integration({
  name: "ApproveCase",
  source: {
    kind: "openapi",
    url: apiUrl,
    method: "POST",
    path: "/cases/{caseId}/approve",
    spec: `${apiUrl}/openapi.json`,
    parameters: [{ name: "caseId", in: "path" }],
    body: "body"
  },
  operation: "approveCase",
  input: t.struct({
    caseId: t.string,
    body: t.struct({ approvedBy: t.string, summary: t.string })
  }),
  output: ApprovalAudit,
  retry: { attempts: 3, backoff: "exponential" }
})

const CaseRejected = t.taggedStruct("CaseRejected", { reason: t.string })

export const ConnectedCaseWorkflow = defineWorkflow({
  name: "ConnectedCaseWorkflow",
  version: 1,
  input: t.struct({
    customerId: t.string,
    customerTier: t.string,
    title: t.string
  }),
  output: t.struct({
    caseId: t.string,
    customerName: t.string,
    approvedBy: t.string,
    auditId: t.string,
    summary: t.string
  }),
  errors: CaseRejected,
  run: function* (input, ctx) {
    const [customer, policy, created] = yield* ctx.all([
      ctx.run(lookupCustomer, { customerId: input.customerId, include: "account" }),
      ctx.run(lookupPolicy, { tier: input.customerTier }),
      ctx.run(createCase, { customerId: input.customerId, title: input.title })
    ], { name: "prepare-connected-case", concurrency: 3 })

    const preparedAt = yield* ctx.now()
    const summary = yield* ctx.code("build-review-summary", {
      reason: "Give the human reviewer one stable summary of all integration results",
      run: () => `${created.caseId}: ${customer.name} (${customer.tier}), approval=${policy.requiresApproval}, prepared=${preparedAt.toISOString()}`
    })

    const approval = yield* ctx.waitForSignal(
      "caseApproval",
      t.struct({ approved: t.boolean, reviewer: t.string }),
      { timeout: "5 minutes" }
    )
    if (approval.type === "timeout" || !approval.value.approved) {
      return yield* ctx.fail({ _tag: "CaseRejected", reason: "case was not approved" })
    }

    const audit = yield* ctx.run(approveCase, {
      caseId: created.caseId,
      body: { approvedBy: approval.value.reviewer, summary }
    })
    return {
      caseId: created.caseId,
      customerName: customer.name,
      approvedBy: audit.approvedBy,
      auditId: audit.auditId,
      summary
    }
  }
})
