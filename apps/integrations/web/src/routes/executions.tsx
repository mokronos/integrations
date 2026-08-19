import { useMemo, useState } from "react"
import { Activity, Search } from "lucide-react"

import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import { connectionLabel, when } from "@/lib/format"
import { useAudit } from "@/lib/queries"
import type { AuditRecord } from "@/lib/schemas"

const outcomeVariant = {
  succeeded: "secondary",
  failed: "destructive",
  denied: "destructive",
  pending: "default"
} satisfies Readonly<
  Record<AuditRecord["outcome"], "default" | "secondary" | "destructive" | "outline">
>

const limits = [50, 100, 250, 500] as const

export function ExecutionsRoute() {
  const [limit, setLimit] = useState<number>(50)
  const [filter, setFilter] = useState("")
  const audit = useAudit(limit)

  const records = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const all = audit.data ?? []
    if (needle.length === 0) return all
    return all.filter((record) =>
      `${record.alias ?? ""} ${record.tool ?? ""} ${record.clientId ?? ""} ${record.outcome} ${
        record.message ?? ""
      }`.toLowerCase().includes(needle)
    )
  }, [audit.data, filter])

  return (
    <Page
      title="Executions"
      description="Every attempt to call through this gateway, allowed or not. Arguments are kept separately and age out; these records do not."
      actions={
        <>
          <Select
            value={String(limit)}
            onValueChange={(value) => setLimit(Number.parseInt(value, 10))}
          >
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              {limits.map((candidate) => (
                <SelectItem key={candidate} value={String(candidate)}>
                  last {candidate}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ReloadButton onClick={() => void audit.refetch()} busy={audit.isFetching} />
        </>
      }
    >
      <QueryError error={audit.error} />

      <div className="relative w-full max-w-sm">
        <Search className="text-muted-foreground absolute left-2 top-1/2 size-3.5 -translate-y-1/2" />
        <Input
          className="pl-7"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by tool, client, or outcome"
        />
      </div>

      {audit.isPending
        ? <LoadingRows rows={6} />
        : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Call</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Connection</TableHead>
                    <TableHead>Decision</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.length === 0
                    ? (
                      <TableRow>
                        <TableCell colSpan={7}>
                          <div className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-sm">
                            <Activity className="size-5" />
                            Nothing recorded yet.
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                    : records.map((record) => (
                      <TableRow key={record.id}>
                        <TableCell className="text-muted-foreground whitespace-nowrap text-sm">
                          {when(record.createdAt)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={outcomeVariant[record.outcome]}>{record.outcome}</Badge>
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {record.alias === null && record.tool === null
                            ? "—"
                            : `${record.alias ?? "?"}.${record.tool ?? "?"}`}
                        </TableCell>
                        <TableCell className="text-muted-foreground font-mono text-xs">
                          {record.clientId ?? "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground font-mono text-xs">
                          {record.connection === null ? "—" : connectionLabel(record.connection)}
                        </TableCell>
                        <TableCell className="text-sm">{record.decision ?? "—"}</TableCell>
                        <TableCell className="text-muted-foreground max-w-xs truncate text-sm">
                          {record.message ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
    </Page>
  )
}
