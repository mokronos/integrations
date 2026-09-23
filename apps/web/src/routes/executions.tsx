import { useMemo, useState } from "react"
import { Activity, Check, ChevronLeft, ChevronRight, Clock3, Filter, Minus, ShieldCheck, X, Zap } from "lucide-react"

import { AuditOutcomeBadge } from "@/components/audit-outcome"
import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { ToolIdentity } from "@/components/integrations/connection-identity"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { when } from "@/lib/format"
import type { AuditQuery } from "@/lib/gateway"
import { whenPresent } from "@integragents/contracts"
import { refetchAll, useAudit, useIntegrations } from "@/lib/queries"
import { Option, Schema } from "effect"
import { AuditOutcome, type AuditRecord } from "@integragents/contracts"

function AuditStrategy({ strategy }: { readonly strategy: AuditRecord["decision"] }) {
  const label = strategy === "allow" ? "Runs immediately" : strategy === "require_approval" ? "Requires approval" : "No policy strategy applied"
  const Icon = strategy === "allow" ? Zap : strategy === "require_approval" ? ShieldCheck : Minus
  return <span role="img" aria-label={label} title={label} className="inline-flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground"><Icon aria-hidden className="size-4" /></span>
}

function AuditDecision({ record }: { readonly record: AuditRecord }) {
  const label = record.outcome === "pending"
    ? "No decision at request time"
    : record.outcome === "denied"
    ? "Denied"
    : record.decision === "require_approval"
    ? "Approved"
    : record.decision === "allow"
    ? "Allowed immediately"
    : "No decision recorded"
  const Icon = record.outcome === "pending" ? Clock3 : record.outcome === "denied" ? X : record.decision === null ? Minus : Check
  return <span role="img" aria-label={label} title={label} className="inline-flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground"><Icon aria-hidden className="size-4" /></span>
}

const limits = [50, 100, 250, 500] as const
const ALL = "all"
const decodeOutcomeFilter = Schema.decodeUnknownSync(Schema.Union([AuditOutcome, Schema.Literal(ALL)]))
const decodeInstant = Schema.decodeUnknownOption(Schema.DateFromString)
const instantFilter = (value: string): string | undefined =>
  Option.getOrUndefined(Option.map(decodeInstant(value), (date) => date.toISOString()))
const outcomeOptions = [
  { value: ALL, label: "Any outcome" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "denied", label: "Denied" },
  { value: "pending", label: "Approval requested" },
] as const
const limitOptions = limits.map((candidate) => ({ value: String(candidate), label: candidate }))

type Filters = {
  readonly clientId: string
  readonly alias: string
  readonly tool: string
  readonly outcome: AuditOutcome | typeof ALL
  readonly since: string
}

const emptyFilters = (): Filters => ({ clientId: "", alias: "", tool: "", outcome: ALL, since: "" })
const optionalText = (value: string): string | undefined => value.trim().length === 0 ? undefined : value.trim()

export function ExecutionsRoute() {
  const [limit, setLimit] = useState<number>(50)
  const [offset, setOffset] = useState(0)
  const [draft, setDraft] = useState<Filters>(emptyFilters)
  const [filters, setFilters] = useState<Filters>(emptyFilters)

  const query = useMemo<AuditQuery>(() => ({
    limit,
    offset,
    ...whenPresent("clientId", optionalText(filters.clientId)),
    ...whenPresent("alias", optionalText(filters.alias)),
    ...whenPresent("tool", optionalText(filters.tool)),
    ...whenPresent("outcome", filters.outcome === ALL ? undefined : filters.outcome),
    ...whenPresent("since", instantFilter(filters.since))
  }), [filters, limit, offset])
  const audit = useAudit(query)
  const integrations = useIntegrations()
  const records = audit.data?.records ?? []
  const total = audit.data?.total ?? 0
  const start = total === 0 ? 0 : offset + 1
  const end = Math.min(offset + records.length, total)
  const filtered = Object.values(filters).some((value) => value !== "" && value !== ALL)

  return (
    <Page
      title="Activity"
      description="A permanent history of gateway calls. An approval request remains here after it is decided."
      actions={<ReloadButton onClick={() => refetchAll(audit)} />}
    >
      <QueryError error={audit.error} />
      <Card>
        <CardContent className="grid min-w-0 gap-2 p-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.1fr)_auto]">
          <Input aria-label="Client ID" value={draft.clientId} onChange={(event) => setDraft({ ...draft, clientId: event.target.value })} placeholder="Client ID" />
          <Input aria-label="Alias" value={draft.alias} onChange={(event) => setDraft({ ...draft, alias: event.target.value })} placeholder="Alias" />
          <Input aria-label="Tool" value={draft.tool} onChange={(event) => setDraft({ ...draft, tool: event.target.value })} placeholder="Tool" />
          <Select aria-label="Outcome" value={draft.outcome} onValueChange={(value) => setDraft({ ...draft, outcome: decodeOutcomeFilter(value) })} items={outcomeOptions} />
          <Input type="datetime-local" value={draft.since} onChange={(event) => setDraft({ ...draft, since: event.target.value })} aria-label="Since" />
          <div className="flex gap-1">
            <Button onClick={() => { setFilters(draft); setOffset(0) }}><Filter className="size-3" /> Apply</Button>
            <Button variant="ghost" size="icon" aria-label="Clear filters" disabled={!filtered && Object.values(draft).every((value) => value === "" || value === ALL)} onClick={() => { const cleared = emptyFilters(); setDraft(cleared); setFilters(cleared); setOffset(0) }}><X className="size-4" /></Button>
          </div>
        </CardContent>
      </Card>

      {audit.isPending ? <LoadingRows rows={6} /> : (
        <Card><CardContent className="p-0">
          <Table>
            <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Outcome</TableHead><TableHead>Tool and connection</TableHead><TableHead>Client</TableHead><TableHead>Strategy</TableHead><TableHead>Decision</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
            <TableBody>{records.length === 0
              ? <TableRow><TableCell colSpan={7}><div className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-sm"><Activity className="size-5" />No matching execution records.</div></TableCell></TableRow>
              : records.map((record) => <TableRow key={record.id}>
                <TableCell className="text-muted-foreground whitespace-nowrap text-sm">{when(record.createdAt)}</TableCell>
                <TableCell><AuditOutcomeBadge outcome={record.outcome} /></TableCell>
                <TableCell className="min-w-52 whitespace-normal"><ToolIdentity connection={record.connection} alias={record.alias} tool={record.tool} integrations={integrations.data ?? []} /></TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">{record.clientId ?? "—"}</TableCell>
                <TableCell><AuditStrategy strategy={record.decision} /></TableCell>
                <TableCell><AuditDecision record={record} /></TableCell>
                <TableCell className="text-muted-foreground max-w-xs truncate text-sm">{record.message ?? "—"}</TableCell>
              </TableRow>)}</TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
            <span className="text-muted-foreground text-xs">{total === 0 ? "No records" : `${start}–${end} of ${total}`}</span>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">Rows per page</span>
              <Select aria-label="Rows per page" className="w-20" value={String(limit)} onValueChange={(next) => { if (next !== null) { setLimit(Number.parseInt(next, 10)); setOffset(0) } }} items={limitOptions} />
              <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}><ChevronLeft className="size-3" /> Previous</Button>
              <Button variant="outline" size="sm" disabled={offset + records.length >= total} onClick={() => setOffset(offset + limit)}>Next <ChevronRight className="size-3" /></Button>
            </div>
          </div>
        </CardContent></Card>
      )}
    </Page>
  )
}
