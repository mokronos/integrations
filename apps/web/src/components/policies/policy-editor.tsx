import { useState } from "react"
import {
  AlertTriangle,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Plus,
  ShieldCheck,
  X
} from "lucide-react"
import { toast } from "sonner"

import { QueryError } from "@/components/page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import * as gateway from "@/lib/gateway"
import { keys, useIntegrations, useInvalidate, useMutation } from "@/lib/queries"
import type {
  IntegrationOverview,
  PolicyDecision,
  PolicyIntegration,
  PolicyTool,
  PolicyToolInput,
  Tool
} from "@/lib/schemas"

const toolKey = (integration: string, tool: string): string => `${integration}\u0000${tool}`

const inputFromStored = (tool: PolicyTool): PolicyToolInput => ({
  integration: tool.integration,
  tool: tool.tool,
  enabled: tool.enabled,
  decision: tool.decision
})

const connectedCatalog = (
  integrations: ReadonlyArray<IntegrationOverview>
): ReadonlyArray<IntegrationOverview> =>
  integrations.filter((integration) => integration.connections.length > 0)

const uniqueTools = (tools: ReadonlyArray<Tool>): ReadonlyArray<Tool> => {
  const byName = new Map<string, Tool>()
  for (const tool of tools) {
    const existing = byName.get(tool.name)
    if (existing === undefined || tool.defaultDecision === "require_approval") {
      byName.set(tool.name, tool)
    }
  }
  return [...byName.values()]
}

function DecisionSwitch({
  decision,
  disabled,
  onChange
}: {
  readonly decision: PolicyDecision
  readonly disabled: boolean
  readonly onChange: (decision: PolicyDecision) => void
}) {
  const requiresApproval = decision === "require_approval"
  return (
    <div className="flex shrink-0 items-center gap-2 text-xs">
      <span className={requiresApproval ? "text-muted-foreground" : "font-medium"}>Allow</span>
      <Switch
        checked={requiresApproval}
        disabled={disabled}
        aria-label="Require approval"
        onCheckedChange={(checked) => onChange(checked ? "require_approval" : "allow")}
      />
      <span className={requiresApproval ? "font-medium" : "text-muted-foreground"}>Require approval</span>
    </div>
  )
}

export function PolicyEditor({
  policyId,
  storedIntegrations,
  storedTools,
  assignedClientCount
}: {
  readonly policyId: string
  readonly storedIntegrations: ReadonlyArray<PolicyIntegration>
  readonly storedTools: ReadonlyArray<PolicyTool>
  readonly assignedClientCount: number
}) {
  const invalidate = useInvalidate()
  const integrations = useIntegrations()
  const [includedIntegrations, setIncludedIntegrations] = useState<ReadonlyArray<string>>(
    storedIntegrations.map((entry) => entry.integration)
  )
  const [tools, setTools] = useState<ReadonlyArray<PolicyToolInput>>(
    storedTools.map(inputFromStored)
  )
  const [expandedIntegrations, setExpandedIntegrations] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const connected = connectedCatalog(integrations.data ?? [])
  const catalogKeys = new Set(
    connected.flatMap((integration) =>
      integration.tools.map((tool) => toolKey(integration.slug, tool.name)))
  )
  const unavailable = tools.filter((tool) =>
    includedIntegrations.includes(tool.integration)
    && !catalogKeys.has(toolKey(tool.integration, tool.tool))
  )
  const enabledCount = tools.filter((tool) => tool.enabled).length

  const configuredTool = (integration: string, tool: string) =>
    tools.find((candidate) => candidate.integration === integration && candidate.tool === tool)

  const replaceTool = (next: PolicyToolInput) => {
    setTools((current) => [
      ...current.filter((candidate) =>
        toolKey(candidate.integration, candidate.tool) !== toolKey(next.integration, next.tool)),
      next
    ])
  }

  const setAllDecisions = (decision: PolicyDecision) => {
    setTools((current) => current.map((tool) => tool.enabled ? { ...tool, decision } : tool))
  }

  const toggleIntegration = (integration: string) => {
    setExpandedIntegrations((current) => {
      const next = new Set(current)
      if (next.has(integration)) next.delete(integration)
      else next.add(integration)
      return next
    })
  }

  const addIntegration = (integration: IntegrationOverview) => {
    const catalogTools = uniqueTools(integration.tools)
    setIncludedIntegrations((current) => current.includes(integration.slug)
      ? current
      : [...current, integration.slug])
    setTools((current) => {
      const currentKeys = new Set(current.map((tool) => toolKey(tool.integration, tool.tool)))
      return [
        ...current,
        ...catalogTools
          .filter((tool) => !currentKeys.has(toolKey(integration.slug, tool.name)))
          .map((tool) => ({
            integration: integration.slug,
            tool: tool.name,
            enabled: true,
            decision: tool.defaultDecision
          }))
      ]
    })
    setExpandedIntegrations((current) => new Set([...current, integration.slug]))
  }

  const removeIntegration = (integration: string) => {
    setIncludedIntegrations((current) => current.filter((candidate) => candidate !== integration))
    setTools((current) => current.filter((tool) => tool.integration !== integration))
    setExpandedIntegrations((current) => {
      const next = new Set(current)
      next.delete(integration)
      return next
    })
  }

  const configurationTools = (): ReadonlyArray<PolicyToolInput> => {
    const configured = new Map(
      tools
        .filter((tool) => includedIntegrations.includes(tool.integration))
        .map((tool) => [toolKey(tool.integration, tool.tool), tool])
    )
    for (const integration of connected) {
      if (!includedIntegrations.includes(integration.slug)) continue
      for (const tool of uniqueTools(integration.tools)) {
        const key = toolKey(integration.slug, tool.name)
        if (!configured.has(key)) {
          configured.set(key, {
            integration: integration.slug,
            tool: tool.name,
            enabled: true,
            decision: tool.defaultDecision
          })
        }
      }
    }
    return [...configured.values()]
  }

  const save = useMutation({
    mutationFn: () => gateway.replacePolicyTools({
      policyId,
      integrations: includedIntegrations,
      tools: configurationTools()
    }),
    onSuccess: () => {
      invalidate(keys.policy(policyId), keys.policies, keys.overview, keys.clients)
      toast.success("Policy saved", {
        description: assignedClientCount === 0
          ? undefined
          : `The change now applies to ${assignedClientCount} assigned client${assignedClientCount === 1 ? "" : "s"}.`
      })
    },
    onError: (error: Error) => toast.error("Could not save policy", { description: error.message })
  })

  return (
    <div className="space-y-4">
      {assignedClientCount > 0 ? (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Shared policy</AlertTitle>
          <AlertDescription>
            Saving changes affects all {assignedClientCount} assigned client{assignedClientCount === 1 ? "" : "s"} immediately.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          {includedIntegrations.length} integration{includedIntegrations.length === 1 ? "" : "s"} added · {enabledCount} tools enabled
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setAllDecisions("allow")} disabled={enabledCount === 0}>
            <CheckCheck className="size-4" />Allow all enabled
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAllDecisions("require_approval")} disabled={enabledCount === 0}>
            <ShieldCheck className="size-4" />Require approval for all enabled
          </Button>
        </div>
      </div>

      {integrations.isPending ? <p className="text-muted-foreground text-sm">Loading connected tools…</p> : null}
      <QueryError error={integrations.error} />
      {connected.length === 0 && !integrations.isPending ? (
        <Card><CardContent className="text-muted-foreground py-8 text-center">No connected integrations are available.</CardContent></Card>
      ) : null}

      {connected.map((integration) => {
        const catalogTools = uniqueTools(integration.tools)
        const included = includedIntegrations.includes(integration.slug)
        const expanded = included && expandedIntegrations.has(integration.slug)
        const toolState = (tool: Tool): PolicyToolInput =>
          configuredTool(integration.slug, tool.name) ?? {
            integration: integration.slug,
            tool: tool.name,
            enabled: true,
            decision: tool.defaultDecision
          }
        const enabledTools = catalogTools.filter((tool) => toolState(tool).enabled).length
        const setIntegrationDecision = (decision: PolicyDecision) => {
          setTools((current) => current.map((tool) =>
            tool.integration === integration.slug && tool.enabled
              ? { ...tool, decision }
              : tool))
        }
        const setIntegrationEnabled = (enabled: boolean) => {
          for (const tool of catalogTools) {
            replaceTool({ ...toolState(tool), enabled })
          }
        }

        return (
          <Card key={integration.slug}>
            <CardHeader className={expanded ? "border-b" : undefined}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  {included ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0"
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${integration.name}`}
                      aria-expanded={expanded}
                      onClick={() => toggleIntegration(integration.slug)}
                    >
                      {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    </Button>
                  ) : <span className="size-8" />}
                  <span className="min-w-0">
                    <CardTitle className="truncate">{integration.name}</CardTitle>
                    <span className="text-muted-foreground font-mono text-xs">{integration.slug}</span>
                  </span>
                  {included
                    ? <Badge variant="secondary">{enabledTools}/{catalogTools.length} enabled</Badge>
                    : <Badge variant="outline">not added</Badge>}
                </div>
                {included ? (
                  <div className="flex flex-wrap gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setIntegrationDecision("allow")}>Allow enabled</Button>
                    <Button variant="ghost" size="sm" onClick={() => setIntegrationDecision("require_approval")}>Approval enabled</Button>
                    <Button variant="ghost" size="sm" onClick={() => removeIntegration(integration.slug)}>
                      <X className="size-3" />Remove integration
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" onClick={() => addIntegration(integration)}>
                    <Plus className="size-4" />Add integration
                  </Button>
                )}
              </div>
            </CardHeader>
            {expanded ? <CardContent className="divide-y px-0">
              <div className="flex flex-wrap justify-end gap-1 px-4 py-2">
                <Button variant="ghost" size="sm" onClick={() => setIntegrationEnabled(true)}>Enable all tools</Button>
                <Button variant="ghost" size="sm" onClick={() => setIntegrationEnabled(false)}>Disable all tools</Button>
              </div>
              {integration.toolError === undefined ? null : (
                <div className="px-4 py-3 text-destructive text-sm">Catalog unavailable: {integration.toolError}</div>
              )}
              {catalogTools.map((tool) => {
                const current = toolState(tool)
                return (
                  <div key={tool.name} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                      <Checkbox
                        checked={current.enabled}
                        onChange={() => replaceTool({ ...current, enabled: !current.enabled })}
                      />
                      <span className="min-w-0">
                        <span className="block font-mono text-sm font-medium">{tool.name}</span>
                        <span className="text-muted-foreground line-clamp-2 text-xs">{tool.description}</span>
                      </span>
                    </label>
                    <DecisionSwitch
                      decision={current.decision}
                      disabled={!current.enabled}
                      onChange={(decision) => replaceTool({ ...current, decision })}
                    />
                  </div>
                )
              })}
            </CardContent> : null}
          </Card>
        )
      })}

      {unavailable.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Unavailable configured tools</CardTitle>
            <p className="text-muted-foreground text-sm">
              These explicit states remain stored even though the tools are not currently in the catalog.
            </p>
          </CardHeader>
          <CardContent className="divide-y px-0">
            {unavailable.map((tool) => (
              <div key={toolKey(tool.integration, tool.tool)} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <Checkbox checked={tool.enabled} onChange={() => replaceTool({ ...tool, enabled: !tool.enabled })} />
                  <code className="min-w-0 break-all text-sm">{tool.integration} / {tool.tool}</code>
                  <Badge variant="outline">unavailable</Badge>
                </label>
                <DecisionSwitch
                  decision={tool.decision}
                  disabled={!tool.enabled}
                  onChange={(decision) => replaceTool({ ...tool, decision })}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardFooter className="justify-between border-t-0">
          <p className="text-muted-foreground text-xs">Save replaces integration membership and explicit tool states atomically.</p>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save policy"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
