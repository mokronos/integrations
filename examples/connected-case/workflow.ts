import { defineWorkflow, integration, t } from "@mokronos/wfkit"

const Customer = t.struct({ id: t.string, name: t.string, tier: t.string })
const Policy = t.struct({ tier: t.string, requiresApproval: t.boolean })
const CreatedCase = t.struct({ caseId: t.string, title: t.string })
const ApprovalAudit = t.struct({ auditId: t.string, caseId: t.string, approvedBy: t.string })

const lookupCustomer = integration({
  name: "LookupCustomer",
  source: { kind: "executor", integration: "crm", tool: "getCustomer" },
  input: t.struct({ customerId: t.string, include: t.string }),
  output: Customer,
  retry: { attempts: 3, backoff: "exponential" }
})

const lookupPolicy = integration({
  name: "LookupPolicy",
  source: { kind: "executor", integration: "crm", tool: "getPolicy" },
  input: t.struct({ tier: t.string }),
  output: Policy
})

const createCase = integration({
  name: "CreateCase",
  source: { kind: "executor", integration: "crm", tool: "createCase" },
  input: t.struct({ customerId: t.string, title: t.string }),
  output: CreatedCase,
  retry: { attempts: 3, backoff: "exponential" }
})

const approveCase = integration({
  // An approval must be recorded against the team's shared credential, never
  // whichever personal account happens to be connected — so this step pins the
  // org tier. Pinning is a constraint: if only a user connection exists, the
  // step fails rather than silently filing the audit under one person.
  name: "ApproveCase",
  source: { kind: "executor", integration: "case_review", tool: "approveCase", owner: "org" },
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
      output: t.string,
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
