import { useState } from "react"
import { toast } from "sonner"
import { ConnectionName, IntegrationSlug } from "@mokronos/contracts"

import { QueryError } from "@/components/page"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import * as gateway from "@/lib/gateway"
import { connectionLabel } from "@/lib/format"
import { keys, useIntegrations, useInvalidate, useMutation } from "@/lib/queries"
import type { AccessProfileTool, ApprovalPolicyTool, ConnectionRef, PolicyDecision } from "@/lib/schemas"

type RouteTool = { readonly connection: ConnectionRef; readonly name: string; readonly description: string }
const keyOf = (connection: ConnectionRef, tool: string) => `${connectionLabel(connection)}:${tool}`

const catalogTools = (integrations: ReturnType<typeof useIntegrations>["data"]): ReadonlyArray<RouteTool> =>
  (integrations ?? []).flatMap((integration) => integration.connections.filter((connection) => connection.owner === "org").flatMap((connection) => {
    const ref: ConnectionRef = { owner: "org", integration: IntegrationSlug.make(integration.slug), name: ConnectionName.make(connection.name) }
    return integration.tools.filter((tool) => tool.owner === "org" && tool.connection === connection.name).map((tool) => ({ connection: ref, name: tool.name, description: tool.description }))
  }))

export function AccessProfileEditor({ id, storedTools, assignedClientCount }: { readonly id: string; readonly storedTools: ReadonlyArray<AccessProfileTool>; readonly assignedClientCount: number }) {
  const integrations = useIntegrations()
  const invalidate = useInvalidate()
  const [enabled, setEnabled] = useState(() => new Set(storedTools.map((tool) => keyOf(tool.connection, tool.tool))))
  const catalog = catalogTools(integrations.data)
  const save = useMutation({
    mutationFn: () => gateway.replaceAccessProfileTools(id, catalog.filter((tool) => enabled.has(keyOf(tool.connection, tool.name))).map((tool) => ({ connection: tool.connection, tool: tool.name }))),
    onSuccess: () => { invalidate(keys.accessProfile(id), keys.accessProfiles, keys.clients, keys.overview); toast.success("Access profile saved") },
    onError: (error: Error) => toast.error("Could not save access profile", { description: error.message })
  })
  return <ToolEditor title="Enabled tools" description="A connection is enabled when at least one of its tools is checked." catalog={catalog} assignedClientCount={assignedClientCount} render={(tool) => {
    const key = keyOf(tool.connection, tool.name)
    return <Checkbox checked={enabled.has(key)} onChange={() => setEnabled((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })} />
  }} save={() => save.mutate()} saving={save.isPending} error={integrations.error} />
}

export function ApprovalPolicyEditor({ id, storedTools, assignedClientCount }: { readonly id: string; readonly storedTools: ReadonlyArray<ApprovalPolicyTool>; readonly assignedClientCount: number }) {
  const integrations = useIntegrations()
  const invalidate = useInvalidate()
  const [decisions, setDecisions] = useState(() => new Map(storedTools.map((tool) => [keyOf(tool.connection, tool.tool), tool.decision])))
  const catalog = catalogTools(integrations.data)
  const decision = (tool: RouteTool): PolicyDecision => decisions.get(keyOf(tool.connection, tool.name)) ?? "require_approval"
  const save = useMutation({
    mutationFn: () => gateway.replaceApprovalPolicyTools(id, catalog.map((tool) => ({ connection: tool.connection, tool: tool.name, decision: decision(tool) }))),
    onSuccess: () => { invalidate(keys.approvalPolicy(id), keys.approvalPolicies, keys.clients, keys.overview); toast.success("Approval policy saved") },
    onError: (error: Error) => toast.error("Could not save approval policy", { description: error.message })
  })
  return <ToolEditor title="Approval decisions" description="Choose whether each connected tool runs immediately or waits for human approval." catalog={catalog} assignedClientCount={assignedClientCount} render={(tool) => {
    const value = decision(tool)
    return <label className="flex items-center gap-2 text-xs"><span>Allow</span><Switch checked={value === "require_approval"} onCheckedChange={(checked) => setDecisions((current) => new Map(current).set(keyOf(tool.connection, tool.name), checked ? "require_approval" : "allow"))} /><span>Require approval</span></label>
  }} save={() => save.mutate()} saving={save.isPending} error={integrations.error} />
}

function ToolEditor({ title, description, catalog, assignedClientCount, render, save, saving, error }: { readonly title: string; readonly description: string; readonly catalog: ReadonlyArray<RouteTool>; readonly assignedClientCount: number; readonly render: (tool: RouteTool) => React.ReactNode; readonly save: () => void; readonly saving: boolean; readonly error: Error | null }) {
  const groups = Map.groupBy(catalog, (tool) => connectionLabel(tool.connection))
  return <div className="space-y-4">
    {assignedClientCount > 0 ? <Alert><AlertDescription>Saving affects all {assignedClientCount} assigned client{assignedClientCount === 1 ? "" : "s"} immediately.</AlertDescription></Alert> : null}
    <QueryError error={error} />
    <Card><CardHeader><CardTitle>{title}</CardTitle><p className="text-muted-foreground text-sm">{description}</p></CardHeader><CardContent className="space-y-5">
      {[...groups].map(([connection, tools]) => <section key={connection} className="space-y-2"><h3 className="border-b pb-2 font-mono text-sm font-medium">{connection}</h3>{tools.map((tool) => <div key={keyOf(tool.connection, tool.name)} className="flex items-center justify-between gap-4 py-1"><div><p className="font-mono text-sm">{tool.name}</p><p className="text-muted-foreground text-xs">{tool.description}</p></div>{render(tool)}</div>)}</section>)}
      {catalog.length === 0 ? <p className="text-muted-foreground py-6 text-center text-sm">No connected tools are available.</p> : null}
    </CardContent><CardFooter className="justify-end"><Button onClick={save} disabled={saving}>{saving ? "Saving..." : "Save"}</Button></CardFooter></Card>
  </div>
}
