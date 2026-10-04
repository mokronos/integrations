import { ChevronRight, Search } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import {
  connectionRefKey,
  connectionRefOf,
  type ApprovalRule,
  type ConnectionRef,
  type IntegrationOverview,
  type Profile,
  type ToolDecision,
  ToolName
} from "@integragents/contracts"

import { ConnectionIdentity, ToolIdentity } from "@/components/integrations/connection-identity"
import { IntegrationIcon, integrationHost } from "@/components/integrations/integration-icon"
import { LoadingRows, QueryError } from "@/components/page"
import { SavedApproval } from "@/components/profiles/saved-approvals"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Segmented } from "@/components/ui/segmented"
import { pluralise } from "@/lib/format"
import * as gateway from "@/lib/gateway"
import { keys, useApprovalRules, useIntegrations, useInvalidate, useMutation, useProfileTools } from "@/lib/queries"
import { cn } from "@/lib/utils"

type Setting = "off" | ToolDecision

const settingOptions = [
  { value: "off", label: "Off", title: "The tool is hidden and cannot be called" },
  { value: "require_approval", label: "Ask", title: "Every call waits for a human" },
  { value: "allow", label: "Allow", title: "Calls run without asking" }
] as const

type Row = {
  readonly key: string
  readonly connection: ConnectionRef
  readonly tool: ToolName
  readonly description: string
  readonly defaultDecision: ToolDecision
}

type ConnectionGroup = { readonly key: string; readonly connection: ConnectionRef; readonly rows: ReadonlyArray<Row> }
type IntegrationGroup = {
  readonly slug: string
  readonly integration: IntegrationOverview | undefined
  readonly connections: ReadonlyArray<ConnectionGroup>
}

const routeKey = (connection: ConnectionRef, tool: string) => `${connectionRefKey(connection)}\u0000${tool}`

/** Every org tool the gateway reaches, plus whatever the profile enables that the catalog does not list, such as tools that act for each user. */
const rowsOf = (
  integrations: ReadonlyArray<IntegrationOverview>,
  enabled: ReadonlyArray<{ readonly connection: ConnectionRef; readonly tool: string }>
): ReadonlyArray<Row> => {
  const rows = new Map<string, Row>()
  for (const integration of integrations) {
    for (const connection of integration.connections) {
      if (connection.owner !== "org") continue
      const ref = connectionRefOf(connection.owner, connection.integration, connection.name)
      for (const tool of integration.tools) {
        if (tool.owner !== "org" || tool.connection !== connection.name) continue
        rows.set(routeKey(ref, tool.name), {
          key: routeKey(ref, tool.name),
          connection: ref,
          tool: ToolName.make(tool.name),
          description: tool.description,
          defaultDecision: tool.defaultDecision
        })
      }
    }
  }
  for (const entry of enabled) {
    const key = routeKey(entry.connection, entry.tool)
    if (rows.has(key)) continue
    const description = integrations.find((integration) => integration.slug === entry.connection.integration)
      ?.tools.find((tool) => tool.name === entry.tool)?.description ?? ""
    rows.set(key, { key, connection: entry.connection, tool: ToolName.make(entry.tool), description, defaultDecision: "require_approval" })
  }
  return [...rows.values()]
}

const groupsOf = (rows: ReadonlyArray<Row>, integrations: ReadonlyArray<IntegrationOverview>): ReadonlyArray<IntegrationGroup> => {
  const bySlug = new Map(integrations.map((integration) => [integration.slug, integration]))
  return [...Map.groupBy(rows, (row) => row.connection.integration)]
    .map(([slug, entries]) => ({
      slug,
      integration: bySlug.get(slug),
      connections: [...Map.groupBy(entries, (row) => connectionRefKey(row.connection))].flatMap(([key, connectionRows]) => {
        const [first] = connectionRows
        return first === undefined ? [] : [{ key, connection: first.connection, rows: connectionRows }]
      })
    }))
    .sort((left, right) => (left.integration?.name ?? left.slug).localeCompare(right.integration?.name ?? right.slug))
}

const sharedSetting = (rows: ReadonlyArray<Row>, settingOf: (row: Row) => Setting): Setting | undefined => {
  const [first, ...rest] = rows.map(settingOf)
  return first !== undefined && rest.every((setting) => setting === first) ? first : undefined
}

const summary = (rows: ReadonlyArray<Row>, settingOf: (row: Row) => Setting): string => {
  const on = rows.filter((row) => settingOf(row) !== "off")
  const asking = on.filter((row) => settingOf(row) === "require_approval").length
  return on.length === 0 ? `${pluralise(rows.length, "tool")}, all off` : `${on.length} of ${rows.length} on · ${asking} ask`
}

export function ProfileTools({ profile }: { readonly profile: Profile }) {
  const integrations = useIntegrations()
  const tools = useProfileTools(profile.id)
  const rules = useApprovalRules(profile.id)
  if (integrations.isPending || tools.isPending) return <LoadingRows rows={4} />
  return <>
    <QueryError error={integrations.error ?? tools.error ?? rules.error} />
    <ToolEditor
      key={(tools.data ?? []).map((tool) => `${routeKey(tool.connection, tool.tool)}=${tool.decision}`).join("|")}
      profile={profile}
      integrations={integrations.data ?? []}
      enabled={tools.data ?? []}
      rules={rules.data ?? []}
    />
  </>
}

function ToolEditor({ profile, integrations, enabled, rules }: {
  readonly profile: Profile
  readonly integrations: ReadonlyArray<IntegrationOverview>
  readonly enabled: ReadonlyArray<{ readonly connection: ConnectionRef; readonly tool: string; readonly decision: ToolDecision }>
  readonly rules: ReadonlyArray<ApprovalRule>
}) {
  const invalidate = useInvalidate()
  const stored = useMemo(() => new Map(enabled.map((tool) => [routeKey(tool.connection, tool.tool), tool.decision])), [enabled])
  const [settings, setSettings] = useState<ReadonlyMap<string, Setting>>(stored)
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const rows = useMemo(() => rowsOf(integrations, enabled), [integrations, enabled])
  const settingOf = (row: Row): Setting => settings.get(row.key) ?? "off"
  const changed = rows.filter((row) => settingOf(row) !== (stored.get(row.key) ?? "off")).length
  const disabled = profile.revokedAt !== null

  const needle = query.trim().toLowerCase()
  const visible = needle.length === 0
    ? rows
    : rows.filter((row) => `${row.connection.integration} ${row.connection.name} ${row.tool} ${row.description}`.toLowerCase().includes(needle))
  const groups = groupsOf(visible, integrations)

  const set = (targets: ReadonlyArray<Row>, setting: (row: Row) => Setting) =>
    setSettings((current) => {
      const next = new Map(current)
      for (const row of targets) next.set(row.key, setting(row))
      return next
    })

  const save = useMutation({
    mutationFn: () => gateway.replaceProfileTools(profile.id, rows.flatMap((row) => {
      const setting = settingOf(row)
      return setting === "off" ? [] : [{ connection: row.connection, tool: row.tool, decision: setting }]
    })),
    onSuccess: () => {
      invalidate(keys.profileTools(profile.id), keys.profiles, keys.overview)
      toast.success("Tools saved")
    },
    onError: (error: Error) => toast.error("Could not save tools", { description: error.message })
  })

  if (rows.length === 0) {
    return <Card><CardContent className="text-muted-foreground py-10 text-center text-sm">
      No connected tools yet. Connect a service under Integrations, then turn its tools on here.
    </CardContent></Card>
  }

  return <div className="space-y-3">
    {rules.length === 0 ? null : <details className="group rounded-xl border">
      <summary className="flex cursor-pointer list-none items-center gap-3 p-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-90" />
        <span className="min-w-0">
          <span className="block font-medium">{pluralise(rules.length, "saved approval")}</span>
          <span className="text-muted-foreground block text-xs">Created with "Always approve". A call to an Ask tool that fits one runs without asking.</span>
        </span>
      </summary>
      <div className="space-y-3 border-t p-3">
        {rules.map((rule) => <div key={rule.id} className="space-y-1">
          <ToolIdentity connection={rule.connection} alias={null} tool={rule.tool} integrations={integrations} className="min-h-0" />
          <SavedApproval rule={rule} profileId={profile.id} />
        </div>)}
      </div>
    </details>}
    <div className="relative">
      <Search aria-hidden className="text-muted-foreground absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
      <Input className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a tool…" aria-label="Find a tool" />
    </div>
    {groups.length === 0 ? <p className="text-muted-foreground py-6 text-center text-sm">Nothing matches “{query.trim()}”.</p> : null}
    {groups.map((group) => {
      const groupRows = group.connections.flatMap((connection) => connection.rows)
      const open = needle.length > 0 || expanded.has(group.slug)
      return <section key={group.slug} className="overflow-hidden rounded-xl border">
        <div className={cn("bg-muted/30 flex flex-wrap items-center gap-3 p-3", open && "border-b")}>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setExpanded((current) => {
              const next = new Set(current)
              if (next.has(group.slug)) next.delete(group.slug); else next.add(group.slug)
              return next
            })}
            className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-md"
          >
            <ChevronRight aria-hidden className={cn("text-muted-foreground size-4 shrink-0 transition-transform", open && "rotate-90")} />
            <IntegrationIcon host={integrationHost(group.integration ?? { slug: group.slug })} size={24} />
            <span className="min-w-0">
              <span className="block truncate font-medium">{group.integration?.name ?? group.slug}</span>
              <span className="text-muted-foreground block truncate text-xs">{summary(groupRows, settingOf)}</span>
            </span>
          </button>
          <BulkSetting rows={groupRows} settingOf={settingOf} set={set} disabled={disabled} label={`All ${group.integration?.name ?? group.slug} tools`} />
        </div>
        {open ? group.connections.map((connection) => <div key={connection.key} className="border-b last:border-b-0">
          {group.connections.length > 1 || connection.connection.owner === "user"
            ? <div className="bg-muted/10 flex flex-wrap items-center gap-3 border-b px-3 py-2 text-sm">
              <ConnectionIdentity connection={connection.connection} integration={group.integration} showIntegration={false} className="flex-1" />
              <BulkSetting rows={connection.rows} settingOf={settingOf} set={set} disabled={disabled} label={`All tools on ${connection.connection.name}`} />
            </div>
            : null}
          <div className="divide-y">
            {connection.rows.map((row) => <ToolRow
              key={row.key}
              row={row}
              setting={settingOf(row)}
              onChange={(setting) => set([row], () => setting)}
              rules={rules.filter((rule) => rule.tool === row.tool && connectionRefKey(rule.connection) === connectionRefKey(row.connection))}
              profile={profile}
              disabled={disabled}
            />)}
          </div>
        </div>) : null}
      </section>
    })}
    {changed === 0 ? null : <div className="bg-background/95 sticky bottom-0 flex flex-wrap items-center justify-end gap-2 rounded-xl border p-3 shadow-lg backdrop-blur">
      <span className="text-muted-foreground mr-auto text-sm">{pluralise(changed, "unsaved change")}</span>
      <Button variant="ghost" onClick={() => setSettings(stored)} disabled={save.isPending}>Discard</Button>
      <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>
    </div>}
  </div>
}

function BulkSetting({ rows, settingOf, set, disabled, label }: {
  readonly rows: ReadonlyArray<Row>
  readonly settingOf: (row: Row) => Setting
  readonly set: (rows: ReadonlyArray<Row>, setting: (row: Row) => Setting) => void
  readonly disabled: boolean
  readonly label: string
}) {
  const defaults = rows.every((row) => settingOf(row) === row.defaultDecision)
  return <span className="flex shrink-0 items-center gap-1">
    <Button
      size="sm"
      variant="ghost"
      className="text-xs"
      disabled={disabled || defaults}
      title="Read-only tools run immediately, the rest ask"
      onClick={() => set(rows, (row) => row.defaultDecision)}
    >
      Defaults
    </Button>
    <Segmented label={label} value={sharedSetting(rows, settingOf)} options={settingOptions} onChange={(setting) => set(rows, () => setting)} disabled={disabled} />
  </span>
}

function ToolRow({ row, setting, onChange, rules, profile, disabled }: {
  readonly row: Row
  readonly setting: Setting
  readonly onChange: (setting: Setting) => void
  readonly rules: ReadonlyArray<ApprovalRule>
  readonly profile: Profile
  readonly disabled: boolean
}) {
  const [showRules, setShowRules] = useState(false)
  return <div className="space-y-2 px-3 py-2.5">
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2">
          <span className="break-all font-mono text-sm">{row.tool}</span>
          {row.defaultDecision === "allow" ? <Badge variant="outline" className="text-[10px]">read-only</Badge> : null}
        </p>
        {row.description.length === 0 ? null : <p className="text-muted-foreground line-clamp-1 text-xs" title={row.description}>{row.description}</p>}
      </div>
      {rules.length === 0 ? null : (
        <Button size="sm" variant="ghost" className="text-xs" aria-expanded={showRules} onClick={() => setShowRules((current) => !current)}>
          {pluralise(rules.length, "saved approval")}
        </Button>
      )}
      <Segmented label={`${row.tool} setting`} value={setting} options={settingOptions} onChange={onChange} disabled={disabled} />
    </div>
    {showRules ? <div className="space-y-2 pl-2">
      <p className="text-muted-foreground text-xs">Calls that fit one of these run without asking, even while the tool is set to Ask.</p>
      {rules.map((rule) => <SavedApproval key={rule.id} rule={rule} profileId={profile.id} />)}
    </div> : null}
  </div>
}
