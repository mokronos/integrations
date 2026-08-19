import { useState } from "react"
import { RefreshCw, Timer } from "lucide-react"
import { toast } from "sonner"

import { Page, QueryError } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { pluralise, when } from "@/lib/format"
import * as gateway from "@/lib/gateway"
import { useIntegrations, useInvalidate, useMutation } from "@/lib/queries"
import type { DriftReport } from "@/lib/schemas"

const ALL = "__all__"

const driftVariant: Readonly<Record<string, "default" | "secondary" | "destructive">> = {
  added: "default",
  changed: "secondary",
  removed: "destructive"
}

export function SystemRoute() {
  const invalidate = useInvalidate()
  const integrations = useIntegrations()
  const [scope, setScope] = useState<string>(ALL)
  const [reports, setReports] = useState<ReadonlyArray<DriftReport>>([])

  const refresh = useMutation({
    mutationFn: () => gateway.refreshDrift(scope === ALL ? undefined : scope),
    onSuccess: (result) => {
      setReports(result)
      invalidate(["integrations"])
      const moved = result.reduce((sum, report) => sum + report.entries.length, 0)
      toast.success(
        moved === 0 ? "Nothing moved" : `${pluralise(moved, "change")} since the last sync`
      )
    },
    onError: (error: Error) => toast.error("Refresh failed", { description: error.message })
  })

  const maintenance = useMutation({
    mutationFn: () => gateway.runMaintenance(),
    onSuccess: (result) => {
      invalidate(["approvals"], ["audit"])
      toast.success("Maintenance run", {
        description:
          `${result.expiredApprovals} approval(s) expired, ${result.expiredAuditArguments} argument row(s) aged out`
      })
    },
    onError: (error: Error) => toast.error("Maintenance failed", { description: error.message })
  })

  return (
    <Page
      title="System"
      description="Catalog drift and the two things that happen on a clock rather than on a request."
    >
      <QueryError error={integrations.error} />

      <Card>
        <CardHeader>
          <CardTitle>Catalog drift</CardTitle>
          <CardDescription>
            Tool names and shapes belong to vendors, so a rename is a normal
            event — but one that silently breaks grants. Refreshing re-reads an
            integration and reports what moved since the last sync.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Every integration</SelectItem>
                {(integrations.data ?? []).map((integration) => (
                  <SelectItem key={integration.slug} value={integration.slug}>
                    {integration.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              <RefreshCw className={refresh.isPending ? "size-4 animate-spin" : "size-4"} />
              {refresh.isPending ? "Refreshing…" : "Refresh"}
            </Button>
          </div>

          {reports.length === 0
            ? <p className="text-muted-foreground text-sm">No refresh run yet.</p>
            : (
              <div className="space-y-3">
                {reports.map((report) => (
                  <div key={report.integration} className="rounded-md border p-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{report.integration}</span>
                      <span className="text-muted-foreground text-xs">
                        checked {when(report.checkedAt)}
                      </span>
                    </div>
                    {report.entries.length === 0
                      ? <p className="text-muted-foreground mt-1 text-sm">Unchanged.</p>
                      : (
                        <ul className="mt-2 space-y-1">
                          {report.entries.map((entry) => (
                            <li
                              key={`${entry.kind}-${entry.connection}-${entry.tool}`}
                              className="flex items-center gap-2 text-sm"
                            >
                              <Badge variant={driftVariant[entry.kind] ?? "outline"}>
                                {entry.kind}
                              </Badge>
                              <code className="font-mono text-xs">
                                {entry.connection}/{entry.tool}
                              </code>
                            </li>
                          ))}
                        </ul>
                      )}
                  </div>
                ))}
              </div>
            )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Maintenance</CardTitle>
          <CardDescription>
            Expires approvals nobody answered and ages out stored arguments. Both
            are decisions rather than cleanups: an approval that expired did not
            fail to be answered — the answer is that the call does not happen.
            The gateway runs this on a loop; this button is for running it now.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={() => maintenance.mutate()}
            disabled={maintenance.isPending}
          >
            <Timer className="size-4" />
            {maintenance.isPending ? "Running…" : "Run maintenance"}
          </Button>
        </CardContent>
      </Card>
    </Page>
  )
}
