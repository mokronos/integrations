import { useState } from "react"
import { toast } from "sonner"
import { ConnectionName, IntegrationSlug } from "@mokronos/contracts"

import { QueryError } from "@/components/page"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
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
  const toggle = (toolKeys: ReadonlyArray<string>, on: boolean) => setEnabled((current) => {
    const next = new Set(current)
    for (const key of toolKeys) if (on) next.add(key); else next.delete(key)
    return next
  })
  return <ToolEditor title="Enabled tools" description="A connection is enabled when at least one of its tools is on." catalog={catalog} assignedClientCount={assignedClientCount} renderGroup={(tools) => {
    // The connection switch is on only when every tool under it is on, so
    // flipping it never hides a half-enabled connection behind an "on" look.
    const toolKeys = tools.map((tool) => keyOf(tool.connection, tool.name))
    const on = toolKeys.filter((key) => enabled.has(key))
    return <ToolSwitch label={`${on.length} of ${toolKeys.length} enabled`} checked={on.length === toolKeys.length} onCheckedChange={(checked) => toggle(toolKeys, checked)} />
  }} render={(tool) => {
    const key = keyOf(tool.connection, tool.name)
    return <ToolSwitch label={enabled.has(key) ? "Enabled" : "Disabled"} checked={enabled.has(key)} onCheckedChange={(checked) => toggle([key], checked)} />
  }} save={() => save.mutate()} saving={save.isPending} error={integrations.error} />
}

function ToolSwitch({ label, checked, onCheckedChange }: { readonly label: string; readonly checked: boolean; readonly onCheckedChange: (checked: boolean) => void }) {
  return <span className="flex shrink-0 items-center gap-2 font-sans text-xs font-normal"><span className="text-muted-foreground">{label}</span><Switch checked={checked} onCheckedChange={onCheckedChange} /></span>
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
  // One state, named, rather than a switch between two labels: the row itself is
  // the toggle now, and "Allow | Require approval" on either side of it gave a
  // click near the words no obvious meaning.
  return <ToolEditor title="Approval decisions" description="Choose whether each connected tool runs immediately or waits for human approval." catalog={catalog} assignedClientCount={assignedClientCount} render={(tool) => {
    const value = decision(tool)
    return <ToolSwitch label={value === "require_approval" ? "Requires approval" : "Runs immediately"} checked={value === "require_approval"} onCheckedChange={(checked) => setDecisions((current) => new Map(current).set(keyOf(tool.connection, tool.name), checked ? "require_approval" : "allow"))} />
  }} save={() => save.mutate()} saving={save.isPending} error={integrations.error} />
}

function ToolEditor({ title, description, catalog, assignedClientCount, render, renderGroup, save, saving, error }: { readonly title: string; readonly description: string; readonly catalog: ReadonlyArray<RouteTool>; readonly assignedClientCount: number; readonly render: (tool: RouteTool) => React.ReactNode; readonly renderGroup?: (tools: ReadonlyArray<RouteTool>) => React.ReactNode; readonly save: () => void; readonly saving: boolean; readonly error: Error | null }) {
  const groups = Map.groupBy(catalog, (tool) => connectionLabel(tool.connection))
  return <div className="space-y-4">
    {assignedClientCount > 0 ? <Alert><AlertDescription>Saving affects all {assignedClientCount} assigned client{assignedClientCount === 1 ? "" : "s"} immediately.</AlertDescription></Alert> : null}
    <QueryError error={error} />
    <Card><CardHeader><CardTitle>{title}</CardTitle><p className="text-muted-foreground text-sm">{description}</p></CardHeader><CardContent className="space-y-5">
      {[...groups].map(([connection, tools]) => <section key={connection} className="space-y-2"><h3 className="flex items-center justify-between gap-3 border-b pb-2 font-mono text-sm font-medium"><span className="min-w-0 truncate">{connection}</span>{renderGroup?.(tools)}</h3>{tools.map((tool) => <Item key={keyOf(tool.connection, tool.name)} asChild interactive variant="plain" size="sm"><label><ItemContent><ItemTitle className="font-mono font-normal">{tool.name}</ItemTitle>{tool.description.length === 0 ? null : <ItemDescription className="line-clamp-2">{tool.description}</ItemDescription>}</ItemContent>{render(tool)}</label></Item>)}</section>)}
      {catalog.length === 0 ? <p className="text-muted-foreground py-6 text-center text-sm">No connected tools are available.</p> : null}
    </CardContent><CardFooter className="justify-end"><Button onClick={save} disabled={saving}>{saving ? "Saving..." : "Save"}</Button></CardFooter></Card>
  </div>
}
