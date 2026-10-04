import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router"

import { AddIntegrationDialog } from "@/components/integrations/add-integration-dialog"
import { ConnectionBadge } from "@/components/integrations/connection-badge"
import { IntegrationDetail } from "@/components/integrations/integration-detail"
import { OAuthSetupDialog } from "@/components/integrations/oauth-setup-dialog"
import {
  IntegrationIcon,
  integrationHost
} from "@/components/integrations/integration-icon"
import { Page, QueryError, ReloadButton } from "@/components/page"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { pluralise } from "@/lib/format"
import { refetchAll, useIntegrations } from "@/lib/queries"

function IntegrationsSkeleton() {
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)]" aria-hidden>
      <Card className="h-fit">
        <CardHeader><Skeleton className="h-9 w-full" /></CardHeader>
        <CardContent className="space-y-2">
          {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-16 w-full" />)}
        </CardContent>
      </Card>
      <Card className="min-h-96">
        <CardHeader className="space-y-3">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-2/3" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-14 w-full" />)}
        </CardContent>
      </Card>
    </div>
  )
}

export function IntegrationsRoute() {
  const navigate = useNavigate()
  const { slug } = useParams()
  const integrations = useIntegrations()
  const [filter, setFilter] = useState("")

  const all = useMemo(() => integrations.data ?? [], [integrations.data])
  const selected = all.find((integration) => integration.slug === slug) ?? all[0]

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
      description="Services the gateway can reach, and the accounts connected to them."
      actions={
        <>
          <AddIntegrationDialog />
          <ReloadButton onClick={() => refetchAll(integrations)} />
        </>
      }
    >
      <OAuthSetupDialog />
      <QueryError error={integrations.error} />

      {integrations.isPending
        ? <IntegrationsSkeleton />
        : all.length === 0
          ? (
            <Card>
              <CardContent className="text-muted-foreground py-10 text-center text-sm">
                No integrations yet. Add one to get started.
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
                    <Item
                      key={integration.slug}
                      variant="outline"
                      size="sm"
                      data-active={selected?.slug === integration.slug}
                      render={
                        <button
                          type="button"
                          onClick={() => void navigate(`/integrations/${integration.slug}`)}
                        />
                      }
                      className="cursor-pointer select-none hover:bg-muted data-[active=true]:border-primary data-[active=true]:bg-accent/50"
                    >
                      <ItemMedia>
                        <IntegrationIcon host={integrationHost(integration)} />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          <span className="min-w-0 truncate">{integration.name}</span>
                          <ConnectionBadge integration={integration} />
                        </ItemTitle>
                        <ItemDescription className="flex items-center gap-1.5 font-mono">
                          <span className="min-w-0 truncate">{integration.slug}</span>
                          <span className="shrink-0">
                            · {pluralise(integration.tools.length, "tool")}
                          </span>
                        </ItemDescription>
                      </ItemContent>
                    </Item>
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
