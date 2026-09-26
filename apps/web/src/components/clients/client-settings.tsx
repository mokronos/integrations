import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import * as gateway from "@/lib/gateway"
import {
  keys,
  useInvalidate,
  useMutation,
  useApprovalDestinations,
  useClientApprovalDestinations
} from "@/lib/queries"
import { Option, Schema } from "effect"
import { ApprovalGroupWindowMinutes, ApprovalMethod, McpSurface, type ApprovalDestinationId, type Client, type ClientCapability } from "@integragents/contracts"

const decodeGroupWindow = (text: string): ApprovalGroupWindowMinutes | undefined =>
  text.trim() === "" ? undefined : Schema.decodeUnknownOption(ApprovalGroupWindowMinutes)(Number(text)).pipe(Option.getOrUndefined)

const mcpSurfaceOptions: ReadonlyArray<{ readonly value: McpSurface; readonly label: string; readonly description: string }> = [
  { value: "tools", label: "Tools", description: "Every tool this client may call appears as its own MCP tool. Best for agents that just need to do work." },
  { value: "discovery", label: "Discovery", description: "The CLI surface as MCP tools: search, connect, tools, schema, execute, approval. Best for agents that set up integrations themselves." }
]

const approvalMethodOptions: ReadonlyArray<{ readonly value: ApprovalMethod; readonly label: string; readonly description: string }> = [
  { value: "elicitation", label: "Ask in the client", description: "MCP clients that support elicitation prompt for approval in the harness; anyone holding this client's credential can answer that prompt. Other callers get an approval link." },
  { value: "link", label: "Approval link", description: "Pending calls return a link to approve them in the dashboard." },
  { value: "none", label: "Dashboard only", description: "Pending calls carry no link; approve them from Approvals or a notification destination." }
]

function DestinationAssignments({ client }: { readonly client: Client }) {
  const destinations = useApprovalDestinations()
  const assigned = useClientApprovalDestinations(client.id)
  const invalidate = useInvalidate()
  const save = useMutation({
    mutationFn: (destinationId: ApprovalDestinationId) => {
      const current = assigned.data ?? []
      const next = current.includes(destinationId)
        ? current.filter((id) => id !== destinationId)
        : [...current, destinationId]
      return gateway.replaceClientApprovalDestinations(client.id, next)
    },
    onSuccess: () => invalidate(keys.clientApprovalDestinations(client.id)),
    onError: (error: Error) => toast.error("Could not update destinations", { description: error.message })
  })
  return <div className="space-y-2">
    <Label>Notification destinations</Label>
    {(destinations.data ?? []).length === 0
      ? <p className="text-muted-foreground text-xs">Create a destination from Approval destinations first.</p>
      : (destinations.data ?? []).map((destination) => <div key={destination.id} className="flex items-center gap-3 rounded-md border p-3">
        <Switch checked={(assigned.data ?? []).includes(destination.id)} disabled={client.revokedAt !== null || save.isPending} onCheckedChange={() => save.mutate(destination.id)} />
        <div><p className="text-sm font-medium">{destination.name}</p><p className="text-muted-foreground text-xs">{destination.url}</p></div>
      </div>)}
  </div>
}

export function ClientSettings({ client }: { readonly client: Client }) {
  const invalidate = useInvalidate()
  const [mayProvision, setMayProvision] = useState(
    client.capabilities.includes("provision_connections")
  )
  const [mayAdminister, setMayAdminister] = useState(
    client.capabilities.includes("administer_gateway")
  )
  const [approvalMethod, setApprovalMethod] = useState<ApprovalMethod>(client.approvalMethod)
  const [mcpSurface, setMcpSurface] = useState<McpSurface>(client.mcpSurface)
  const [groupWindow, setGroupWindow] = useState(String(client.approvalGroupWindowMinutes))
  const groupWindowMinutes = decodeGroupWindow(groupWindow)

  const save = useMutation({
    mutationFn: () => {
      const capabilities: Array<ClientCapability> = []
      if (mayProvision) capabilities.push("provision_connections")
      if (mayAdminister) capabilities.push("administer_gateway")
      return gateway.updateClientSettings(client.id, {
        capabilities,
        approvalMethod,
        mcpSurface,
        approvalGroupWindowMinutes: groupWindowMinutes ?? client.approvalGroupWindowMinutes
      })
    },
    onSuccess: () => {
      invalidate(keys.clients)
      toast.success("Client settings saved")
    },
    onError: (error: Error) => toast.error("Could not save client settings", {
      description: error.message
    })
  })

  const disabled = client.revokedAt !== null
  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP surface, authority and approval delivery</CardTitle>
        <CardDescription>
          Tool access comes from the assigned policy. These settings control what an MCP
          client sees and which wider control-plane actions this credential may perform.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-1.5 rounded-md border p-3 lg:col-span-2">
          <Label>MCP surface</Label>
          <Select
            className="w-full sm:w-72"
            value={mcpSurface}
            onValueChange={(next) => { if (next !== null) setMcpSurface(Schema.decodeUnknownSync(McpSurface)(next)) }}
            items={mcpSurfaceOptions}
            disabled={disabled}
          />
          <p className="text-muted-foreground text-xs">
            {mcpSurfaceOptions.find((option) => option.value === mcpSurface)?.description}
          </p>
        </div>
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-md border p-3">
            <Switch
              id="settings-provision"
              checked={mayProvision}
              onCheckedChange={setMayProvision}
              disabled={disabled}
            />
            <div className="space-y-1">
              <Label htmlFor="settings-provision">Provision connections</Label>
              <p className="text-muted-foreground text-xs">Discover integrations and create or remove connections.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-md border p-3">
            <Switch
              id="settings-administer"
              checked={mayAdminister}
              onCheckedChange={setMayAdminister}
              disabled={disabled}
            />
            <div className="space-y-1">
              <Label htmlFor="settings-administer">Administer gateway</Label>
              <p className="text-muted-foreground text-xs">Manage clients, policies, approvals, and audit data.</p>
            </div>
          </div>
        </div>
        <div className="space-y-3 rounded-md border p-3">
          <div className="space-y-1.5">
            <Label>Approval method</Label>
            <Select
              className="w-full sm:w-72"
              value={approvalMethod}
              onValueChange={(next) => { if (next !== null) setApprovalMethod(Schema.decodeUnknownSync(ApprovalMethod)(next)) }}
              items={approvalMethodOptions}
              disabled={disabled}
            />
            <p className="text-muted-foreground text-xs">
              {approvalMethodOptions.find((option) => option.value === approvalMethod)?.description}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="settings-group-window">Group calls within (minutes)</Label>
            <Input
              id="settings-group-window"
              className="w-full sm:w-32"
              type="number"
              inputMode="numeric"
              min={0}
              max={1440}
              value={groupWindow}
              onChange={(event) => setGroupWindow(event.target.value)}
              aria-invalid={groupWindowMinutes === undefined}
              disabled={disabled}
            />
            <p className="text-muted-foreground text-xs">
              Pending calls to the same tool that start within this many minutes of the first one are shown and decided together, and notify once. 0 keeps every call separate.
            </p>
          </div>
          <DestinationAssignments client={client} />
        </div>
      </CardContent>
      <CardFooter>
        <Button onClick={() => save.mutate()} disabled={disabled || save.isPending || groupWindowMinutes === undefined}>
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
      </CardFooter>
    </Card>
  )
}
