import { Link } from "react-router"
import {
  Activity,
  ArrowRight,
  Check,
  Circle,
  FileKey2,
  KeyRound,
  Plug,
  ShieldCheck,
  Workflow
} from "lucide-react"

import { LoadingRows, Page, QueryError } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { when } from "@/lib/format"
import { useOverview } from "@/lib/queries"

function Stat({
  label,
  value,
  to,
  icon: Icon
}: {
  readonly label: string
  readonly value: number
  readonly to: string
  readonly icon: typeof Plug
}) {
  return (
    <Link to={to} className="block">
      <Card className="transition-colors hover:bg-muted/30">
        <CardContent className="flex items-center gap-3">
          <div className="rounded-lg bg-muted p-2"><Icon className="size-4" /></div>
          <div>
            <p className="text-2xl font-semibold tabular-nums">{value}</p>
            <p className="text-muted-foreground text-xs">{label}</p>
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}

function SetupStep({ complete, children, to }: {
  readonly complete: boolean
  readonly children: string
  readonly to: string
}) {
  return (
    <Link to={to} className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/40">
      {complete
        ? <span className="rounded-full bg-primary p-1 text-primary-foreground"><Check className="size-3" /></span>
        : <Circle className="size-5 text-muted-foreground" />}
      <span className={complete ? "text-muted-foreground line-through" : "font-medium"}>{children}</span>
      <ArrowRight className="ml-auto size-4 text-muted-foreground" />
    </Link>
  )
}

export function OverviewRoute() {
  const overview = useOverview()
  const connected = overview.data?.connections ?? 0
  const clients = overview.data?.clients ?? 0
  const pending = overview.data?.pendingApprovals ?? 0
  const profiles = overview.data?.accessProfiles ?? 0
  const profileTools = overview.data?.accessProfileTools ?? 0
  const keys = overview.data?.keys ?? 0

  return (
    <Page
      title="Overview"
      description="Connection health, delegated authority, and calls waiting for you."
      actions={pending === 0 ? undefined : (
        <Button asChild><Link to="/approvals">Review {pending} pending</Link></Button>
      )}
    >
      <QueryError error={overview.error} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="connections" value={connected} to="/integrations" icon={Plug} />
        <Stat label="active clients" value={clients} to="/clients" icon={KeyRound} />
        <Stat label="access profiles" value={profiles} to="/access-profiles" icon={FileKey2} />
        <Stat label="enabled tools" value={profileTools} to="/access-profiles" icon={Workflow} />
        <Stat label="pending approvals" value={pending} to="/approvals" icon={ShieldCheck} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Ready a client</CardTitle>
            <CardDescription>New clients inherit the default access profile and approval policy.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <SetupStep complete={connected > 0} to="/integrations">Connect an integration</SetupStep>
            <SetupStep complete={clients > 0} to="/clients">Create an invocation client</SetupStep>
            <SetupStep complete={profileTools > 0} to="/access-profiles">Choose enabled tools</SetupStep>
            <SetupStep complete={keys > 0} to="/clients">Issue a client key</SetupStep>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>Latest delegated execution attempts.</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" asChild><Link to="/activity">View all</Link></Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {overview.isPending
              ? <LoadingRows rows={5} />
              : (overview.data?.recentActivity ?? []).length === 0
              ? <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm"><Activity className="size-4" />No calls yet.</div>
              : <div className="divide-y">{(overview.data?.recentActivity ?? []).map((record) => (
                <div key={record.id} className="flex items-center gap-3 py-3">
                  <Badge variant={record.outcome === "succeeded" ? "secondary" : record.outcome === "pending" ? "default" : "destructive"}>
                    {record.outcome}
                  </Badge>
                  <code className="min-w-0 flex-1 truncate font-mono text-xs">
                    {record.alias === null || record.tool === null ? "unresolved call" : `${record.alias}.${record.tool}`}
                  </code>
                  <span className="text-muted-foreground whitespace-nowrap text-xs">{when(record.createdAt)}</span>
                </div>
              ))}</div>}
          </CardContent>
        </Card>
      </div>
    </Page>
  )
}
