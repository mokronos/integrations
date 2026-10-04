import { useEffect, useState } from "react"
import { ShieldCheck } from "lucide-react"
import { Link, useSearchParams } from "react-router"
import { Schema } from "effect"

import { ApprovalList } from "@/components/approvals/approval-list"
import { LoadingRows, Page, QueryError } from "@/components/page"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useApprovals } from "@/lib/queries"

const View = Schema.Literals(["waiting", "decided"])
const decodeView = Schema.decodeUnknownSync(View)

/** The most recent decisions; everything older is in Activity. */
const decidedShown = 50

export function ApprovalsRoute() {
  const [searchParams] = useSearchParams()
  const selected = searchParams.get("approval")
  const [view, setView] = useState<typeof View.Type>("waiting")
  const approvals = useApprovals(view === "waiting" ? "pending" : "all")
  const shown = view === "waiting"
    ? approvals.data ?? []
    : (approvals.data ?? []).filter((approval) => approval.status !== "pending").slice(0, decidedShown)

  useEffect(() => {
    if (selected === null || approvals.isPending) return
    document.getElementById(`approval-${selected}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
  }, [approvals.isPending, selected])

  return (
    <Page title="Approvals" description="Calls waiting for your decision. An approved call runs once, exactly as shown.">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={view} onValueChange={(value) => setView(decodeView(value))}>
          <TabsList>
            <TabsTrigger value="waiting">Waiting</TabsTrigger>
            <TabsTrigger value="decided">Recently decided</TabsTrigger>
          </TabsList>
        </Tabs>
        {view === "decided" ? <Button variant="ghost" size="sm" render={<Link to="/activity" />}>Full history in Activity</Button> : null}
      </div>

      <QueryError error={approvals.error} />

      {approvals.isPending
        ? <LoadingRows />
        : shown.length === 0
        ? (
          <Card>
            <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-sm">
              <ShieldCheck className="size-6" />
              {view === "waiting" ? "Nothing is waiting for you." : "Nothing decided yet."}
            </CardContent>
          </Card>
        )
        : <ApprovalList approvals={shown} selected={selected} />}
    </Page>
  )
}
