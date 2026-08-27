import { RefreshCcw } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router"
import { toast } from "sonner"

import { ConnectionBadge } from "@/components/integrations/connection-badge"
import { DiscoverDialog } from "@/components/integrations/discover-dialog"
import { IntegrationDetail } from "@/components/integrations/integration-detail"
import { RegistrySearchDialog } from "@/components/integrations/registry-search-dialog"
import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import * as gateway from "@/lib/gateway"
import { useIntegrations, useMutation } from "@/lib/queries"
import { cn } from "@/lib/utils"
export function IntegrationsRoute() {
  const navigate = useNavigate()
  const { slug } = useParams()
  const integrations = useIntegrations()
  const [filter, setFilter] = useState("")

  const all = useMemo(() => integrations.data ?? [], [integrations.data])
  const selected = all.find((integration) => integration.slug === slug) ?? all[0]
  const drift = useMutation({
    mutationFn: () => gateway.refreshDrift(selected?.slug),
    onSuccess: (reports) => {
      const changes = reports.reduce((total, report) => total + report.entries.length, 0)
      toast.success(changes === 0 ? "Tool contract is current" : `${changes} contract change(s) found`, {
        description: changes === 0 ? undefined : "Run `ii drift` for the complete machine-readable report."
      })
    },
    onError: (error: Error) => toast.error("Could not check contract drift", {
      description: error.message
    })
  })

  const listed = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle.length === 0) return all
    return all.filter((integration) =>
      `${integration.name} ${integration.slug}`.toLowerCase().includes(needle)
    )
  }, [all, filter])

  return (
    <Page
      title="Integrations"
      description="What this gateway knows how to reach, and which of it is connected."
      actions={
        <>
          <RegistrySearchDialog />
          <DiscoverDialog />
          <Button
            variant="outline"
            onClick={() => drift.mutate()}
            disabled={selected === undefined || drift.isPending}
          >
            <RefreshCcw className={drift.isPending ? "size-4 animate-spin" : "size-4"} />
            Check drift
          </Button>
          <ReloadButton
            onClick={() => void integrations.refetch()}
            busy={integrations.isFetching}
          />
        </>
      }
    >
      <QueryError error={integrations.error} />

      {integrations.isPending
        ? <LoadingRows />
        : all.length === 0
          ? (
            <Card>
              <CardContent className="text-muted-foreground py-10 text-center text-sm">
                No integrations yet. Discover one to get started.
              </CardContent>
            </Card>
          )
          : (
            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)]">
              <Card className="h-fit">
                <CardHeader>
                  <Input
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="Filter integrations"
                  />
                </CardHeader>
                <CardContent className="space-y-1">
                  {listed.map((integration) => (
                    <button
                      key={integration.slug}
                      type="button"
                      onClick={() => void navigate(`/integrations/${integration.slug}`)}
                      className={cn(
                        "flex min-w-0 w-full flex-col gap-1 rounded-md border p-2 text-left text-sm transition-colors",
                        selected?.slug === integration.slug
                          ? "border-primary bg-accent/40"
                          : "hover:bg-accent/20"
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate font-medium">{integration.name}</span>
                        <ConnectionBadge integration={integration} />
                      </span>
                      <span className="text-muted-foreground flex min-w-0 items-center gap-2 font-mono text-xs">
                        <span className="min-w-0 truncate">{integration.slug}</span>
                        <span className="shrink-0">· {integration.tools.length} tools</span>
                      </span>
                    </button>
                  ))}
                </CardContent>
              </Card>

              {selected === undefined
                ? null
                : <IntegrationDetail integration={selected} />}
            </div>
          )}
    </Page>
  )
}
