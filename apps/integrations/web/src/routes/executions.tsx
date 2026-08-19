import { useMemo, useState } from "react"
import { Activity, ChevronLeft, ChevronRight, Filter, X } from "lucide-react"

import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { connectionLabel, when } from "@/lib/format"
import type { AuditQuery } from "@/lib/gateway"
import { whenPresent } from "@/lib/optional"
import { useAudit } from "@/lib/queries"
import { decodeAuditOutcomeFilter } from "@/lib/schemas"
import type { AuditOutcome, AuditRecord } from "@/lib/schemas"

const outcomeVariant = {
  succeeded: "secondary",
  failed: "destructive",
  denied: "destructive",
  pending: "default"
} satisfies Readonly<Record<AuditRecord["outcome"], "default" | "secondary" | "destructive">>

const limits = [50, 100, 250, 500] as const
const ALL = "all"

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
    ...whenPresent("since", filters.since.length === 0 ? undefined : new Date(filters.since).toISOString())
  }), [filters, limit, offset])
  const audit = useAudit(query)
  const records = audit.data?.records ?? []
  const total = audit.data?.total ?? 0
  const start = total === 0 ? 0 : offset + 1
  const end = Math.min(offset + records.length, total)
  const filtered = Object.values(filters).some((value) => value !== "" && value !== ALL)

  return (
    <Page
      title="Executions"
      description="Every attempt to call through this gateway, allowed or not. Filtered and paged at the gateway so the permanent trail stays useful as it grows."
      actions={<><Select value={String(limit)} onValueChange={(value) => { setLimit(Number.parseInt(value, 10)); setOffset(0) }}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent>{limits.map((candidate) => <SelectItem key={candidate} value={String(candidate)}>{candidate} / page</SelectItem>)}</SelectContent></Select><ReloadButton onClick={() => void audit.refetch()} busy={audit.isFetching} /></>}
    >
      <QueryError error={audit.error} />
      <Card>
        <CardContent className="grid gap-2 p-3 md:grid-cols-2 xl:grid-cols-[1.2fr_1fr_1fr_0.8fr_1.1fr_auto]">
          <Input value={draft.clientId} onChange={(event) => setDraft({ ...draft, clientId: event.target.value })} placeholder="Client ID" />
          <Input value={draft.alias} onChange={(event) => setDraft({ ...draft, alias: event.target.value })} placeholder="Alias" />
          <Input value={draft.tool} onChange={(event) => setDraft({ ...draft, tool: event.target.value })} placeholder="Tool" />
          <Select value={draft.outcome} onValueChange={(value) => setDraft({ ...draft, outcome: decodeAuditOutcomeFilter(value) })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value={ALL}>Any outcome</SelectItem><SelectItem value="succeeded">Succeeded</SelectItem><SelectItem value="failed">Failed</SelectItem><SelectItem value="denied">Denied</SelectItem><SelectItem value="pending">Pending</SelectItem></SelectContent></Select>
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
            <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Outcome</TableHead><TableHead>Call</TableHead><TableHead>Client</TableHead><TableHead>Connection</TableHead><TableHead>Decision</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
            <TableBody>{records.length === 0
              ? <TableRow><TableCell colSpan={7}><div className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-sm"><Activity className="size-5" />No matching execution records.</div></TableCell></TableRow>
              : records.map((record) => <TableRow key={record.id}>
                <TableCell className="text-muted-foreground whitespace-nowrap text-sm">{when(record.createdAt)}</TableCell>
                <TableCell><Badge variant={outcomeVariant[record.outcome]}>{record.outcome}</Badge></TableCell>
                <TableCell className="font-mono text-sm">{record.alias === null && record.tool === null ? "—" : `${record.alias ?? "?"}.${record.tool ?? "?"}`}</TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">{record.clientId ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">{record.connection === null ? "—" : connectionLabel(record.connection)}</TableCell>
                <TableCell className="text-sm">{record.decision ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground max-w-xs truncate text-sm">{record.message ?? "—"}</TableCell>
              </TableRow>)}</TableBody>
          </Table>
          <div className="flex items-center justify-between border-t px-3 py-2"><span className="text-muted-foreground text-xs">{total === 0 ? "No records" : `${start}–${end} of ${total}`}</span><div className="flex gap-1"><Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}><ChevronLeft className="size-3" /> Previous</Button><Button variant="outline" size="sm" disabled={offset + records.length >= total} onClick={() => setOffset(offset + limit)}>Next <ChevronRight className="size-3" /></Button></div></div>
        </CardContent></Card>
      )}
    </Page>
  )
}
