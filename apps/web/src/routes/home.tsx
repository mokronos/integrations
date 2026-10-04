import { Link, Navigate } from "react-router"
import { Activity, AlertTriangle, ArrowRight, Check, Circle, PartyPopper } from "lucide-react"

import { useSession } from "@/components/auth-gate"
import { ApprovalList } from "@/components/approvals/approval-list"
import { AuditOutcomeBadge } from "@/components/audit-outcome"
import { ToolIdentity } from "@/components/integrations/connection-identity"
import { IntegrationIcon, integrationHost } from "@/components/integrations/integration-icon"
import { LoadingRows, Page, QueryError } from "@/components/page"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { pluralise, when } from "@/lib/format"
import { useApprovals, useIntegrations, useOverview } from "@/lib/queries"

/** Pending calls shown here before the rest wait on the Approvals page. */
const pendingShown = 3

function SetupStep({ complete, children, to }: {
  readonly complete: boolean
  readonly children: string
  readonly to: string
}) {
  return (
    <Item variant="outline" size="sm" render={<Link to={to} />}>
      <ItemMedia>
        {complete
          ? <span className="bg-primary text-primary-foreground rounded-full p-1"><Check className="size-3" /></span>
          : <Circle className="size-5" />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle className={complete ? "text-muted-foreground font-normal line-through" : undefined}>{children}</ItemTitle>
      </ItemContent>
      <ArrowRight className="text-muted-foreground ml-auto size-4 shrink-0" />
    </Item>
  )
}

export function HomeRoute() {
  const overview = useOverview()
  const integrations = useIntegrations()
  const pending = useApprovals("pending")
  const session = useSession()
  const counts = overview.data

  if (counts !== undefined && counts.connections === 0 && counts.profileTools === 0
    && session?.authenticated && localStorage.getItem(`gateway-onboarding:${session.tenantId}`) !== "done") {
    return <Navigate to="/onboarding" replace />
  }

  const broken = (integrations.data ?? []).flatMap((integration) => [
    ...integration.connections
      .filter((connection) => connection.status !== "connected")
      .map((connection) => ({
        key: `${integration.slug}/${connection.owner}/${connection.name}`,
        integration,
        title: `${integration.name} needs you to sign in again`,
        detail: connection.identityLabel ?? connection.name
      })),
    ...(integration.toolError === undefined ? [] : [{
      key: `${integration.slug}/tools`,
      integration,
      title: `${integration.name} could not list its tools`,
      detail: integration.toolError
    }])
  ])
  const waiting = pending.data ?? []
  const steps = counts === undefined ? [] : [
    { complete: counts.connections > 0, to: "/integrations", label: "Connect a service" },
    { complete: counts.profiles > 0, to: "/profiles", label: "Create a profile for your agents" },
    { complete: counts.profileTools > 0, to: "/profiles", label: "Turn on the tools they may use" },
    { complete: counts.keys > 0, to: "/profiles", label: "Connect an app to the profile" }
  ]
  const setupLeft = steps.some((step) => !step.complete)

  return (
    <Page title="Home">
      <QueryError error={overview.error ?? integrations.error ?? pending.error} />

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Needs your attention</h2>
          {waiting.length > pendingShown
            ? <Button variant="ghost" size="sm" render={<Link to="/approvals" />}>All {waiting.length} approvals</Button>
            : null}
        </div>
        {pending.isPending || integrations.isPending
          ? <LoadingRows rows={2} />
          : waiting.length === 0 && broken.length === 0
          ? <Card><CardContent className="text-muted-foreground flex items-center gap-2 py-6 text-sm"><PartyPopper className="size-4" />Nothing is waiting for you.</CardContent></Card>
          : <>
            {broken.map((issue) => <Item key={issue.key} variant="outline" className="border-destructive/40">
              <ItemMedia><IntegrationIcon host={integrationHost(issue.integration)} size={24} /></ItemMedia>
              <ItemContent>
                <ItemTitle><AlertTriangle className="text-destructive size-4" />{issue.title}</ItemTitle>
                <ItemDescription className="line-clamp-1">{issue.detail}</ItemDescription>
              </ItemContent>
              <ItemActions><Button size="sm" render={<Link to={`/integrations/${issue.integration.slug}`} />}>Fix</Button></ItemActions>
            </Item>)}
            {waiting.length === 0 ? null : <ApprovalList approvals={waiting.slice(0, pendingShown)} />}
          </>}
      </section>

      {setupLeft ? <Card>
        <CardHeader>
          <CardTitle>Get started</CardTitle>
          <CardDescription>{pluralise(steps.filter((step) => !step.complete).length, "step")} left.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {steps.map((step) => <SetupStep key={step.label} complete={step.complete} to={step.to}>{step.label}</SetupStep>)}
        </CardContent>
      </Card> : null}

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardAction><Button variant="ghost" size="sm" render={<Link to="/activity" />}>View all</Button></CardAction>
        </CardHeader>
        <CardContent>
          {overview.isPending
            ? <LoadingRows rows={5} />
            : (counts?.recentActivity ?? []).length === 0
            ? <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm"><Activity className="size-4" />No calls yet.</div>
            : <div className="divide-y">{(counts?.recentActivity ?? []).map((record) => (
              <div key={record.id} className="flex min-w-0 items-center gap-3 py-3">
                <AuditOutcomeBadge outcome={record.outcome} />
                <ToolIdentity connection={record.connection} alias={record.alias} tool={record.tool} integrations={integrations.data ?? []} className="flex-1" />
                <span className="text-muted-foreground hidden text-xs sm:inline">{record.caller.credentialName ?? ""}</span>
                <span className="text-muted-foreground whitespace-nowrap text-xs">{when(record.createdAt)}</span>
              </div>
            ))}</div>}
        </CardContent>
      </Card>
    </Page>
  )
}
