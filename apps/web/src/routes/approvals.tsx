import { useEffect, useState } from "react"
import { Check, ChevronRight, ShieldCheck, X } from "lucide-react"
import { useSearchParams } from "react-router"
import { toast } from "sonner"

import { JsonView } from "@/components/json-view"
import { ToolIdentity } from "@/components/integrations/connection-identity"
import { LoadingRows, Page, QueryError } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { argumentAt, groupApprovals, splitArguments, type ArgumentPath } from "@/lib/approval-groups"
import { pluralise, until, when } from "@/lib/format"
import { cn } from "@/lib/utils"
import * as gateway from "@/lib/gateway"
import { useApprovals, useIntegrations, useInvalidate, useMutation } from "@/lib/queries"
import { Schema } from "effect"
import { ApprovalStatus, isJsonString, type ApprovalId, type ApprovalVerdict, type IntegrationOverview, type Json, type ListedApproval } from "@integragents/contracts"

const decodeApprovalFilter = Schema.decodeUnknownSync(Schema.Union([ApprovalStatus, Schema.Literal("all")]))

const statusVariant = {
  pending: "default",
  executing: "secondary",
  approved: "secondary",
  denied: "destructive",
  expired: "outline"
} satisfies Readonly<
  Record<ApprovalStatus, "default" | "secondary" | "destructive" | "outline">
>

function ApprovalCard({
  approval,
  selected,
  integrations
}: {
  readonly approval: ListedApproval
  readonly selected: boolean
  readonly integrations: ReadonlyArray<IntegrationOverview>
}) {
  const invalidate = useInvalidate()
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    if (approval.status !== "pending") return
    const remaining = approval.expiresAt.getTime() - Date.now()
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, remaining))
    return () => window.clearTimeout(timer)
  }, [approval.expiresAt, approval.status])

  const decide = useMutation({
    mutationFn: (verdict: "approve" | "deny") =>
      verdict === "approve"
        ? gateway.approveApproval(approval.id)
        : gateway.denyApproval(approval.id),
    onSuccess: (response, verdict) => {
      invalidate(["approvals"], ["audit"])
      if (response.approval?.error) toast.error("Approved, but the call failed", { description: response.approval.error })
      else toast.success(verdict === "approve" ? "Approved and performed" : "Denied")
    },
    onError: (error: Error) => toast.error("Could not decide", { description: error.message })
  })

  return (
    <Card
      id={`approval-${approval.id}`}
      className={selected ? "ring-2 ring-primary" : undefined}
    >
      <CardContent className="space-y-3 p-4">
        <div className="flex min-w-0 items-start gap-2">
          <ToolIdentity connection={null} alias={approval.alias} tool={approval.tool} integrations={integrations} className="min-h-0 flex-1" />
          <Badge variant={statusVariant[approval.status]}>{approval.status}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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

        {approval.status === "executing" ? <p role="status" className="text-sm text-muted-foreground">
          Execution has started. If it was interrupted, the action may already have completed.
          Check the connected service before requesting it again; the gateway will not rerun this approval.
        </p> : null}
        <JsonView value={approval.arguments} label="arguments" defaultOpen={approval.status === "pending"} />
        <Deliveries approvals={[approval]} />
        {approval.result === null ? null : <JsonView value={approval.result} label="result" />}
        {approval.error === null
          ? null
          : <p className="text-destructive text-sm">{approval.error}</p>}

        {approval.status === "pending"
          ? (
            <div className="flex flex-wrap gap-2">
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

const pathLabel = (path: ArgumentPath): string => path.length === 0 ? "arguments" : path.join(".")

const cellText = (value: Json | undefined): string =>
  value === undefined ? "—" : isJsonString(value) ? value : JSON.stringify(value)

function Deliveries({ approvals }: { readonly approvals: ReadonlyArray<ListedApproval> }) {
  const deliveries = approvals.flatMap((approval) => approval.deliveries)
  if (deliveries.length === 0) return null
  return <div className="flex flex-wrap gap-2">
    {deliveries.map((delivery) => <Badge key={delivery.id} variant={delivery.status === "failed" ? "destructive" : "outline"}>
      {delivery.destinationName}: {delivery.status}{delivery.attempts > 0 ? ` (${delivery.attempts})` : ""}
    </Badge>)}
  </div>
}

function ApprovalGroupCard({
  approvals,
  selected,
  integrations
}: {
  readonly approvals: ReadonlyArray<ListedApproval>
  readonly selected: string | null
  readonly integrations: ReadonlyArray<IntegrationOverview>
}) {
  const invalidate = useInvalidate()
  const [open, setOpen] = useState(true)
  const [excluded, setExcluded] = useState<ReadonlySet<ApprovalId>>(new Set())
  const { shared, varying } = splitArguments(approvals.map((approval) => approval.arguments))
  const decidable = approvals.filter((approval) => approval.status === "pending" && approval.expiresAt.getTime() > Date.now())
  const chosen = decidable.filter((approval) => !excluded.has(approval.id)).map((approval) => approval.id)
  const [head, ...rest] = chosen
  const counts = ApprovalStatus.literals
    .map((status) => [status, approvals.filter((approval) => approval.status === status).length] as const)
    .filter(([, count]) => count > 0)
  const earliestExpiry = decidable.reduce<Date | undefined>(
    (earliest, approval) => earliest === undefined || approval.expiresAt < earliest ? approval.expiresAt : earliest,
    undefined
  )
  const showOutcome = approvals.some((approval) => approval.result !== null || approval.error !== null)

  const decide = useMutation({
    mutationFn: ({ verdict, ids }: { readonly verdict: ApprovalVerdict; readonly ids: readonly [ApprovalId, ...Array<ApprovalId>] }) =>
      gateway.decideApprovals(verdict, ids),
    onSuccess: (results, { verdict }) => {
      invalidate(["approvals"], ["audit"])
      setExcluded(new Set())
      const refused = results.filter((result) => result.status === "refused").length
      const failed = results.filter((result) => result.status === "decided" && result.approval.error !== null).length
      const done = results.length - refused - failed
      const summary = `${verdict === "approve" ? "Approved and performed" : "Denied"} ${pluralise(done, "call")}`
      if (refused + failed === 0) toast.success(summary)
      else toast.error(summary, {
        description: [
          failed > 0 ? `${pluralise(failed, "call")} failed when run` : undefined,
          refused > 0 ? `${pluralise(refused, "call")} could not be decided` : undefined
        ].filter((line) => line !== undefined).join(" · ")
      })
    },
    onError: (error: Error) => toast.error("Could not decide", { description: error.message })
  })

  const toggle = (id: ApprovalId) => setExcluded((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const allChosen = decidable.length > 0 && chosen.length === decidable.length
  const [first] = approvals
  if (first === undefined) return null

  return (
    <Card className={approvals.some((approval) => approval.id === selected) ? "ring-2 ring-primary" : undefined}>
      <CardContent className="space-y-3 p-4">
        <div className="flex min-w-0 items-start gap-2">
          <ToolIdentity connection={null} alias={first.alias} tool={first.tool} integrations={integrations} className="min-h-0 flex-1" />
          {counts.map(([status, count]) => <Badge key={status} variant={statusVariant[status]}>{count} {status}</Badge>)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">
            {pluralise(approvals.length, "call")} · first asked {when(first.createdAt)}
          </span>
          {earliestExpiry === undefined ? null : <span className="text-muted-foreground text-xs">· {until(earliestExpiry)}</span>}
          <code className="text-muted-foreground ml-auto font-mono text-xs">{first.clientId}</code>
        </div>

        <JsonView value={shared} label="shared arguments" defaultOpen={decidable.length > 0} />

        <div className="space-y-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 max-w-full gap-1 px-1.5 font-mono text-xs"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
            <span className="font-medium">calls</span>
            <span className="text-muted-foreground truncate font-normal">
              · {varying.length === 0 ? "identical arguments" : `differ in ${varying.map(pathLabel).join(", ")}`}
            </span>
          </Button>
          {open ? (
            <div className="max-h-96 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <input
                        type="checkbox"
                        aria-label="Select every pending call"
                        className="accent-primary size-4 align-middle"
                        checked={allChosen}
                        disabled={decidable.length === 0 || decide.isPending}
                        onChange={() => setExcluded(allChosen ? new Set(decidable.map((approval) => approval.id)) : new Set())}
                      />
                    </TableHead>
                    {varying.map((path) => <TableHead key={pathLabel(path)} className="font-mono text-xs">{pathLabel(path)}</TableHead>)}
                    <TableHead>Status</TableHead>
                    {showOutcome ? <TableHead>Outcome</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {approvals.map((approval) => {
                    const canDecide = decidable.includes(approval)
                    return (
                      <TableRow
                        key={approval.id}
                        id={`approval-${approval.id}`}
                        data-state={approval.id === selected ? "selected" : undefined}
                      >
                        <TableCell>
                          <input
                            type="checkbox"
                            aria-label={`Include ${approval.id}`}
                            className="accent-primary size-4 align-middle"
                            checked={canDecide && !excluded.has(approval.id)}
                            disabled={!canDecide || decide.isPending}
                            onChange={() => toggle(approval.id)}
                          />
                        </TableCell>
                        {varying.map((path) => {
                          const text = cellText(argumentAt(approval.arguments, path))
                          return <TableCell key={pathLabel(path)} className="max-w-64 truncate font-mono text-xs" title={text}>{text}</TableCell>
                        })}
                        <TableCell><Badge variant={statusVariant[approval.status]}>{approval.status}</Badge></TableCell>
                        {showOutcome ? (
                          <TableCell className="max-w-64 text-xs">
                            {approval.error !== null
                              ? <span className="text-destructive">{approval.error}</span>
                              : approval.result === null ? null : <JsonView value={approval.result} label="result" />}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </div>

        <Deliveries approvals={approvals} />

        {decidable.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => { if (head !== undefined) decide.mutate({ verdict: "approve", ids: [head, ...rest] }) }}
              disabled={decide.isPending || head === undefined}
            >
              <Check className="size-3" />
              Approve {chosen.length} and run
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { if (head !== undefined) decide.mutate({ verdict: "deny", ids: [head, ...rest] }) }}
              disabled={decide.isPending || head === undefined}
            >
              <X className="size-3" />
              Deny {chosen.length}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function ApprovalsRoute() {
  const [searchParams] = useSearchParams()
  const selected = searchParams.get("approval")
  const [filter, setFilter] = useState<ApprovalStatus | "all">("pending")
  const approvals = useApprovals(filter)
  const integrations = useIntegrations()

  useEffect(() => {
    if (selected === null || approvals.isPending) return
    document.getElementById(`approval-${selected}`)?.scrollIntoView({
      behavior: "smooth",
      block: "center"
    })
  }, [approvals.isPending, selected])

  return (
    <Page
      title="Approvals"
      description="Calls frozen awaiting a human. The gateway performs an approved call itself, so approving discharges one invocation rather than handing over the capability."
    >
      <Tabs value={filter} onValueChange={(value) => setFilter(decodeApprovalFilter(value))}>
        <TabsList>
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="executing">Executing</TabsTrigger>
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
            {groupApprovals(approvals.data ?? []).map((group) => {
              const [only, ...others] = group
              if (only === undefined) return null
              return others.length === 0
                ? <ApprovalCard key={only.id} approval={only} selected={only.id === selected} integrations={integrations.data ?? []} />
                : <ApprovalGroupCard key={only.groupId} approvals={group} selected={selected} integrations={integrations.data ?? []} />
            })}
          </div>
        )}
    </Page>
  )
}
