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
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import * as gateway from "@/lib/gateway"
import {
  keys,
  useInvalidate,
  useMutation,
  useApprovalDestinations,
  useClientApprovalDestinations
} from "@/lib/queries"
import type { ApprovalDestinationId, Client } from "@/lib/schemas"

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
  const [returnLink, setReturnLink] = useState(client.approvalDelivery.returnLink)

  const save = useMutation({
    mutationFn: () => {
      const capabilities: Array<"provision_connections" | "administer_gateway"> = []
      if (mayProvision) capabilities.push("provision_connections")
      if (mayAdminister) capabilities.push("administer_gateway")
      return gateway.updateClientSettings({
        clientId: client.id,
        capabilities,
        approvalDelivery: { returnLink }
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
        <CardTitle>Authority and approval delivery</CardTitle>
        <CardDescription>
          Tool access comes from the assigned policy. These switches control the wider
          control-plane actions this credential may perform.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
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
          <div className="flex items-start gap-3">
            <Switch
              id="settings-return-link"
              checked={returnLink}
              onCheckedChange={setReturnLink}
              disabled={disabled}
            />
            <div className="space-y-1">
              <Label htmlFor="settings-return-link">Return approval link</Label>
              <p className="text-muted-foreground text-xs">Include a signed-in dashboard destination in pending outcomes.</p>
            </div>
          </div>
          <DestinationAssignments client={client} />
        </div>
      </CardContent>
      <CardFooter>
        <Button onClick={() => save.mutate()} disabled={disabled || save.isPending}>
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
      </CardFooter>
    </Card>
  )
}
