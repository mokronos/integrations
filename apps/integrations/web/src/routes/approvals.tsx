import { useState } from "react"
import { Check, ShieldCheck, X } from "lucide-react"
import { toast } from "sonner"

import { JsonView } from "@/components/json-view"
import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { until, when } from "@/lib/format"
import * as gateway from "@/lib/gateway"
import { useApprovals, useInvalidate, useMutation } from "@/lib/queries"
import { decodeApprovalFilter } from "@/lib/schemas"
import type { ApprovalStatus, PendingApproval } from "@/lib/schemas"

const statusVariant = {
  pending: "default",
  approved: "secondary",
  denied: "destructive",
  expired: "outline"
} satisfies Readonly<
  Record<ApprovalStatus, "default" | "secondary" | "destructive" | "outline">
>

function ApprovalCard({ approval }: { readonly approval: PendingApproval }) {
  const invalidate = useInvalidate()
  const expired = approval.expiresAt.getTime() <= Date.now()

  const decide = useMutation({
    mutationFn: (verdict: "approve" | "deny") =>
      verdict === "approve"
        ? gateway.approveApproval({ id: approval.id })
        : gateway.denyApproval({ id: approval.id }),
    onSuccess: (_, verdict) => {
      invalidate(["approvals"], ["audit"])
      toast.success(verdict === "approve" ? "Approved and performed" : "Denied")
    },
    onError: (error: Error) => toast.error("Could not decide", { description: error.message })
  })

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusVariant[approval.status]}>{approval.status}</Badge>
          <code className="font-mono text-sm font-medium">
            {approval.alias}.{approval.tool}
          </code>
          <span className="text-muted-foreground text-xs">
            asked {when(approval.createdAt)}
          </span>
          <span
            className={expired && approval.status === "pending"
              ? "text-destructive text-xs"
              : "text-muted-foreground text-xs"}
          >
            · {approval.status === "pending" ? until(approval.expiresAt) : when(approval.expiresAt)}
          </span>
          <code className="text-muted-foreground ml-auto font-mono text-xs">
            {approval.clientId}
          </code>
        </div>

        {/* The arguments are frozen at propose time — what you approve is
            exactly this call, not a capability to make it again. */}
        <JsonView value={approval.arguments} label="arguments" />
        {approval.result === null ? null : <JsonView value={approval.result} label="result" />}
        {approval.error === null
          ? null
          : <p className="text-destructive text-sm">{approval.error}</p>}

        {approval.status === "pending"
          ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => decide.mutate("approve")}
                disabled={decide.isPending || expired}
              >
                <Check className="size-3" />
                Approve and run
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => decide.mutate("deny")}
                disabled={decide.isPending}
              >
                <X className="size-3" />
                Deny
              </Button>
              {expired
                ? (
                  <span className="text-muted-foreground self-center text-xs">
                    Expired — the invocation does not happen.
                  </span>
                )
                : null}
            </div>
          )
          : (
            <p className="text-muted-foreground text-xs">
              {approval.decidedBy === null
                ? "Settled"
                : `Decided by ${approval.decidedBy}`} {when(approval.decidedAt)}
            </p>
          )}
      </CardContent>
    </Card>
  )
}

export function ApprovalsRoute() {
  const [filter, setFilter] = useState<ApprovalStatus | "all">("pending")
  const approvals = useApprovals(filter)

  return (
    <Page
      title="Approvals"
      description="Calls frozen awaiting a human. The gateway performs an approved call itself, so approving discharges one invocation rather than handing over the capability."
      actions={<ReloadButton onClick={() => void approvals.refetch()} busy={approvals.isFetching} />}
    >
      <Tabs value={filter} onValueChange={(value) => setFilter(decodeApprovalFilter(value))}>
        <TabsList>
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="approved">Approved</TabsTrigger>
          <TabsTrigger value="denied">Denied</TabsTrigger>
          <TabsTrigger value="expired">Expired</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      <QueryError error={approvals.error} />

      {approvals.isPending
        ? <LoadingRows />
        : (approvals.data ?? []).length === 0
        ? (
          <Card>
            <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-sm">
              <ShieldCheck className="size-6" />
              Nothing {filter === "all" ? "recorded" : filter}.
            </CardContent>
          </Card>
        )
        : (
          <div className="space-y-3">
            {(approvals.data ?? []).map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} />
            ))}
          </div>
        )}
    </Page>
  )
}
