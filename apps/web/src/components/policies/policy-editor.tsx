import { ChevronRight, Search } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { ConnectionName, IntegrationSlug } from "@mokronos/contracts"

import { QueryError } from "@/components/page"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { Switch } from "@/components/ui/switch"
import * as gateway from "@/lib/gateway"
import { connectionLabel, pluralise } from "@/lib/format"
import { cn } from "@/lib/utils"
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

/** Whether a tool answers what was typed. Connection, name, and description all
 *  count, because "which of these touches mail" and "what was that tool called"
 *  are the same box to the person typing. */
const matches = (tool: RouteTool, query: string): boolean => {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  return `${connectionLabel(tool.connection)} ${tool.name} ${tool.description}`
    .toLowerCase()
    .includes(needle)
}

function ToolEditor({ title, description, catalog, assignedClientCount, render, renderGroup, save, saving, error }: { readonly title: string; readonly description: string; readonly catalog: ReadonlyArray<RouteTool>; readonly assignedClientCount: number; readonly render: (tool: RouteTool) => React.ReactNode; readonly renderGroup?: (tools: ReadonlyArray<RouteTool>) => React.ReactNode; readonly save: () => void; readonly saving: boolean; readonly error: Error | null }) {
  const [query, setQuery] = useState("")
  // Closed until asked about: a tenant with a dozen connections is hundreds of
  // rows, and the question is nearly always about one of them.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const searching = query.trim().length > 0
  const groups = [...Map.groupBy(catalog, (tool) => connectionLabel(tool.connection))]
    .map(([connection, tools]) => ({ connection, tools: tools.filter((tool) => matches(tool, query)) }))
    // A connection with nothing matching is not a collapsed connection, it is
    // one that has no answer to the question.
    .filter((group) => group.tools.length > 0)

  return <div className="space-y-4">
    {assignedClientCount > 0 ? <Alert><AlertDescription>Saving affects all {assignedClientCount} assigned client{assignedClientCount === 1 ? "" : "s"} immediately.</AlertDescription></Alert> : null}
    <QueryError error={error} />
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-muted-foreground text-sm">{description}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {catalog.length === 0 ? null : <div className="relative">
          <Search aria-hidden className="text-muted-foreground absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
          <Input className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search connections and tools…" aria-label="Search connections and tools" />
        </div>}
        {groups.map(({ connection, tools }) => {
          // A search that left everything closed would answer nothing, so a
          // match opens its connection without disturbing what was opened by
          // hand — clearing the box returns to that.
          const open = searching || expanded.has(connection)
          return <section key={connection} className="space-y-2">
            <div className="flex items-center gap-2 border-b pb-2">
              <Item asChild interactive variant="plain" size="sm" className="min-w-0 flex-1">
                <button type="button" aria-expanded={open} onClick={() => setExpanded((current) => {
                  const next = new Set(current)
                  if (next.has(connection)) next.delete(connection); else next.add(connection)
                  return next
                })}>
                  <ChevronRight aria-hidden className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} />
                  <ItemContent><ItemTitle className="font-mono font-medium">{connection}</ItemTitle></ItemContent>
                  {/* Only when nothing else is counting: the access editor's
                      group control already reads "N of M enabled". */}
                  {renderGroup === undefined ? <span className="text-muted-foreground shrink-0 text-xs">{pluralise(tools.length, "tool")}</span> : null}
                </button>
              </Item>
              {/* The group control acts on what the search has left showing, so
                  flipping it never reaches a row the operator cannot see. */}
              {renderGroup?.(tools)}
            </div>
            {open ? tools.map((tool) => <Item key={keyOf(tool.connection, tool.name)} asChild interactive variant="plain" size="sm"><label><ItemContent><ItemTitle className="font-mono font-normal">{tool.name}</ItemTitle>{tool.description.length === 0 ? null : <ItemDescription className="line-clamp-2">{tool.description}</ItemDescription>}</ItemContent>{render(tool)}</label></Item>) : null}
          </section>
        })}
        {catalog.length === 0
          ? <p className="text-muted-foreground py-6 text-center text-sm">No connected tools are available.</p>
          : groups.length === 0
          ? <p className="text-muted-foreground py-6 text-center text-sm">Nothing matches “{query.trim()}”.</p>
          : null}
      </CardContent>
      <CardFooter className="justify-end"><Button onClick={save} disabled={saving}>{saving ? "Saving..." : "Save"}</Button></CardFooter>
    </Card>
  </div>
}
