import { useState } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import { Option, Schema } from "effect"
import {
  ApprovalGroupWindowMinutes,
  ApprovalMethod,
  McpSurface,
  type ApprovalDestinationId,
  type Profile,
  type ProfileCapability
} from "@integragents/contracts"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import * as gateway from "@/lib/gateway"
import { keys, useApprovalDestinations, useInvalidate, useMutation, useProfileApprovalDestinations } from "@/lib/queries"

const decodeGroupWindow = (text: string): ApprovalGroupWindowMinutes | undefined =>
  text.trim() === "" ? undefined : Schema.decodeUnknownOption(ApprovalGroupWindowMinutes)(Number(text)).pipe(Option.getOrUndefined)

const mcpSurfaceOptions: ReadonlyArray<{ readonly value: McpSurface; readonly label: string; readonly description: string }> = [
  { value: "tools", label: "Tools", description: "Every enabled tool appears as its own MCP tool. Best for agents that just need to do work." },
  { value: "discovery", label: "Discovery", description: "The CLI's commands as MCP tools: search, connect, tools, schema, execute, approval. Best for agents that set up integrations themselves." }
]

const approvalMethodOptions: ReadonlyArray<{ readonly value: ApprovalMethod; readonly label: string; readonly description: string }> = [
  { value: "elicitation", label: "Ask in the app", description: "MCP apps that support it ask you right in the conversation; anyone holding this profile's credential can answer. Other callers get an approval link." },
  { value: "link", label: "Approval link", description: "Calls that ask return a link to approve them in the dashboard." },
  { value: "none", label: "Dashboard only", description: "Calls that ask carry no link; approve them from Approvals or a notification." }
]

const capabilityOptions: ReadonlyArray<{ readonly value: ProfileCapability; readonly label: string; readonly description: string }> = [
  { value: "provision_connections", label: "Connect services", description: "Its apps may discover integrations and add or remove connections." },
  { value: "administer_gateway", label: "Administer the gateway", description: "Its apps may manage profiles, keys, approvals, and the activity log." }
]

function Setting({ title, description, children }: {
  readonly title: string
  readonly description?: React.ReactNode
  readonly children: React.ReactNode
}) {
  return <div className="grid gap-2 border-b py-4 last:border-b-0 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] sm:gap-6">
    <div className="space-y-1">
      <p className="text-sm font-medium">{title}</p>
      {description === undefined ? null : <p className="text-muted-foreground text-xs">{description}</p>}
    </div>
    <div className="min-w-0 space-y-2">{children}</div>
  </div>
}

export function ProfileSettings({ profile }: { readonly profile: Profile }) {
  const destinations = useApprovalDestinations()
  const assigned = useProfileApprovalDestinations(profile.id)
  if (assigned.isPending) return null
  return <SettingsForm key={`${profile.id}:${(assigned.data ?? []).join(",")}`} profile={profile} destinations={destinations.data ?? []} assigned={assigned.data ?? []} />
}

function SettingsForm({ profile, destinations, assigned }: {
  readonly profile: Profile
  readonly destinations: ReadonlyArray<{ readonly id: ApprovalDestinationId; readonly name: string; readonly url: string }>
  readonly assigned: ReadonlyArray<ApprovalDestinationId>
}) {
  const invalidate = useInvalidate()
  const [capabilities, setCapabilities] = useState<ReadonlySet<ProfileCapability>>(new Set(profile.capabilities))
  const [approvalMethod, setApprovalMethod] = useState<ApprovalMethod>(profile.approvalMethod)
  const [mcpSurface, setMcpSurface] = useState<McpSurface>(profile.mcpSurface)
  const [groupWindow, setGroupWindow] = useState(String(profile.approvalGroupWindowMinutes))
  const [includeNewTools, setIncludeNewTools] = useState(profile.includeNewTools)
  const [destinationIds, setDestinationIds] = useState<ReadonlySet<ApprovalDestinationId>>(new Set(assigned))
  const groupWindowMinutes = decodeGroupWindow(groupWindow)
  const disabled = profile.revokedAt !== null

  const save = useMutation({
    mutationFn: async () => {
      await gateway.updateProfileSettings(profile.id, {
        capabilities: capabilityOptions.map((option) => option.value).filter((value) => capabilities.has(value)),
        approvalMethod,
        mcpSurface,
        approvalGroupWindowMinutes: groupWindowMinutes ?? profile.approvalGroupWindowMinutes,
        includeNewTools
      })
      await gateway.replaceProfileApprovalDestinations(profile.id, [...destinationIds])
    },
    onSuccess: () => {
      invalidate(keys.profiles, keys.profileApprovalDestinations(profile.id))
      toast.success("Settings saved")
    },
    onError: (error: Error) => toast.error("Could not save settings", { description: error.message })
  })

  return <Card>
    <CardHeader>
      <CardTitle>Settings</CardTitle>
      <CardDescription>Shared by every app that uses this profile.</CardDescription>
    </CardHeader>
    <CardContent>
      <Setting title="New services" description="What happens to the tools of a service connected later.">
        <label className="flex items-start gap-3">
          <Switch checked={includeNewTools} onCheckedChange={setIncludeNewTools} disabled={disabled} />
          <span className="text-sm">
            Turn them on with their defaults
            <span className="text-muted-foreground block text-xs">Read-only tools run immediately, the rest ask. Off means you turn each tool on yourself.</span>
          </span>
        </label>
      </Setting>
      <Setting title="Approvals" description="How a call that asks reaches you.">
        <Select
          className="w-full sm:w-72"
          value={approvalMethod}
          onValueChange={(next) => { if (next !== null) setApprovalMethod(Schema.decodeUnknownSync(ApprovalMethod)(next)) }}
          items={approvalMethodOptions}
          disabled={disabled}
        />
        <p className="text-muted-foreground text-xs">{approvalMethodOptions.find((option) => option.value === approvalMethod)?.description}</p>
        <div className="flex items-center gap-2 pt-1">
          <Label htmlFor="settings-group-window" className="font-normal">Group calls to the same tool within</Label>
          <Input
            id="settings-group-window"
            className="w-20"
            type="number"
            inputMode="numeric"
            min={0}
            max={1440}
            value={groupWindow}
            onChange={(event) => setGroupWindow(event.target.value)}
            aria-invalid={groupWindowMinutes === undefined}
            disabled={disabled}
          />
          <span className="text-sm">minutes</span>
        </div>
        <p className="text-muted-foreground text-xs">Grouped calls are decided together and notify once. 0 keeps every call separate.</p>
      </Setting>
      <Setting title="Notifications" description={<>Webhooks told about every call that asks. <Link to="/settings" className="underline">Manage destinations</Link></>}>
        {destinations.length === 0
          ? <p className="text-muted-foreground text-sm">No destinations yet.</p>
          : destinations.map((destination) => <label key={destination.id} className="flex items-center gap-3">
            <Switch
              checked={destinationIds.has(destination.id)}
              disabled={disabled}
              onCheckedChange={(checked) => setDestinationIds((current) => {
                const next = new Set(current)
                if (checked) next.add(destination.id); else next.delete(destination.id)
                return next
              })}
            />
            <span className="min-w-0 text-sm">{destination.name}<span className="text-muted-foreground block truncate text-xs">{destination.url}</span></span>
          </label>)}
      </Setting>
      <Setting title="MCP surface" description="What an MCP app sees when it connects.">
        <Select
          className="w-full sm:w-72"
          value={mcpSurface}
          onValueChange={(next) => { if (next !== null) setMcpSurface(Schema.decodeUnknownSync(McpSurface)(next)) }}
          items={mcpSurfaceOptions}
          disabled={disabled}
        />
        <p className="text-muted-foreground text-xs">{mcpSurfaceOptions.find((option) => option.value === mcpSurface)?.description}</p>
      </Setting>
      <Setting title="Gateway access" description="Beyond calling tools.">
        {capabilityOptions.map((option) => <label key={option.value} className="flex items-start gap-3">
          <Switch
            checked={capabilities.has(option.value)}
            disabled={disabled}
            onCheckedChange={(checked) => setCapabilities((current) => {
              const next = new Set(current)
              if (checked) next.add(option.value); else next.delete(option.value)
              return next
            })}
          />
          <span className="text-sm">{option.label}<span className="text-muted-foreground block text-xs">{option.description}</span></span>
        </label>)}
      </Setting>
    </CardContent>
    <CardFooter className="justify-end">
      <Button onClick={() => save.mutate()} disabled={disabled || save.isPending || groupWindowMinutes === undefined}>
        {save.isPending ? "Saving…" : "Save settings"}
      </Button>
    </CardFooter>
  </Card>
}
