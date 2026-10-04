import { useMemo, useState } from "react"
import { Activity, ChevronLeft, ChevronRight, Filter, X } from "lucide-react"
import { Link } from "react-router"

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
import { refetchAll, useAudit, useIntegrations, useProfiles } from "@/lib/queries"
import { Option, Schema } from "effect"
import { AuditOutcome, type AuditRecord, type ProfileId } from "@integragents/contracts"

/** Whether a human was involved, which the outcome alone does not say. */
const decidedBy = (record: AuditRecord): string | undefined =>
  record.decision === "require_approval" && (record.outcome === "succeeded" || record.outcome === "failed")
    ? record.message?.startsWith("approved by saved rule") === true ? "saved approval" : "approved"
    : undefined

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
  readonly profileId: string
  readonly tool: string
  readonly outcome: AuditOutcome | typeof ALL
  readonly since: string
}

const emptyFilters = (): Filters => ({ profileId: ALL, tool: "", outcome: ALL, since: "" })
const optionalText = (value: string): string | undefined => value.trim().length === 0 ? undefined : value.trim()

export function ActivityRoute() {
  const [limit, setLimit] = useState<number>(50)
  const [offset, setOffset] = useState(0)
  const [draft, setDraft] = useState<Filters>(emptyFilters)
  const [filters, setFilters] = useState<Filters>(emptyFilters)

  const profiles = useProfiles()
  const profileOptions = [
    { value: ALL, label: "Any profile" },
    ...(profiles.data ?? []).map((entry) => ({ value: entry.profile.id, label: entry.profile.name }))
  ]
  const query = useMemo<AuditQuery>(() => ({
    limit,
    offset,
    ...whenPresent("profileId", profiles.data?.find((entry) => entry.profile.id === filters.profileId)?.profile.id),
    ...whenPresent("tool", optionalText(filters.tool)),
    ...whenPresent("outcome", filters.outcome === ALL ? undefined : filters.outcome),
    ...whenPresent("since", instantFilter(filters.since))
  }), [filters, limit, offset, profiles.data])
  const audit = useAudit(query)
  const integrations = useIntegrations()
  const records = audit.data?.records ?? []
  const total = audit.data?.total ?? 0
  const start = total === 0 ? 0 : offset + 1
  const end = Math.min(offset + records.length, total)
  const filtered = Object.values(filters).some((value) => value !== "" && value !== ALL)
  const profileName = (id: ProfileId | null) => profiles.data?.find((entry) => entry.profile.id === id)?.profile.name

  return (
    <Page
      title="Activity"
      description="Every call made through the gateway, including ones that waited for approval."
      actions={<ReloadButton onClick={() => refetchAll(audit)} />}
    >
      <QueryError error={audit.error} />
      <Card>
        <CardContent className="grid min-w-0 gap-2 p-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.1fr)_auto]">
          <Select aria-label="Profile" className="w-full" value={draft.profileId} onValueChange={(value) => setDraft({ ...draft, profileId: value ?? ALL })} items={profileOptions} />
          <Input aria-label="Tool" value={draft.tool} onChange={(event) => setDraft({ ...draft, tool: event.target.value })} placeholder="Tool" />
          <Select aria-label="Outcome" className="w-full" value={draft.outcome} onValueChange={(value) => setDraft({ ...draft, outcome: decodeOutcomeFilter(value) })} items={outcomeOptions} />
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
            <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Outcome</TableHead><TableHead>Tool</TableHead><TableHead>Profile</TableHead><TableHead>Via</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
            <TableBody>{records.length === 0
              ? <TableRow><TableCell colSpan={6}><div className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-sm"><Activity className="size-5" />No matching execution records.</div></TableCell></TableRow>
              : records.map((record) => <TableRow key={record.id}>
                <TableCell className="text-muted-foreground whitespace-nowrap text-sm">{when(record.createdAt)}</TableCell>
                <TableCell>
                  <AuditOutcomeBadge outcome={record.outcome} />
                  {decidedBy(record) === undefined ? null : <span className="text-muted-foreground block pt-1 text-xs">{decidedBy(record)}</span>}
                </TableCell>
                <TableCell className="min-w-52 whitespace-normal"><ToolIdentity connection={record.connection} alias={record.alias} tool={record.tool} integrations={integrations.data ?? []} /></TableCell>
                <TableCell className="text-sm">
                  {record.profileId === null ? "—" : <Link to={`/profiles/${record.profileId}`} className="hover:underline">{profileName(record.profileId) ?? "Unknown"}</Link>}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {record.caller.credentialName ?? "—"}
                  {record.caller.agent === null ? null : <span className="block text-xs">{record.caller.agent}</span>}
                </TableCell>
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
