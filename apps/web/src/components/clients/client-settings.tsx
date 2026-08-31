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
import { Textarea } from "@/components/ui/textarea"
import * as gateway from "@/lib/gateway"
import {
  keys,
  useInvalidate,
  useMutation
} from "@/lib/queries"
import type { Client } from "@/lib/schemas"

const webhookLines = (source: string): ReadonlyArray<string> =>
  source.split("\n").map((value) => value.trim()).filter((value) => value.length > 0)

export function ClientSettings({ client }: { readonly client: Client }) {
  const invalidate = useInvalidate()
  const [mayProvision, setMayProvision] = useState(
    client.capabilities.includes("provision_connections")
  )
  const [mayAdminister, setMayAdminister] = useState(
    client.capabilities.includes("administer_gateway")
  )
  const [returnLink, setReturnLink] = useState(client.approvalDelivery.returnLink)
  const [webhooks, setWebhooks] = useState(client.approvalDelivery.webhooks.join("\n"))
  const parsedWebhooks = webhookLines(webhooks)
  const validWebhooks = parsedWebhooks.length <= 10 &&
    parsedWebhooks.every((url) => /^https?:\/\/[^\s]+$/.test(url))

  const save = useMutation({
    mutationFn: () => {
      const capabilities: Array<"provision_connections" | "administer_gateway"> = []
      if (mayProvision) capabilities.push("provision_connections")
      if (mayAdminister) capabilities.push("administer_gateway")
      return gateway.updateClientSettings({
        clientId: client.id,
        capabilities,
        approvalDelivery: { returnLink, webhooks: parsedWebhooks }
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
          <div className="space-y-1.5">
            <Label htmlFor="settings-webhooks">Notification webhooks</Label>
            <Textarea
              id="settings-webhooks"
              value={webhooks}
              onChange={(event) => setWebhooks(event.target.value)}
              disabled={disabled}
              placeholder="https://automation.example/hooks/approvals"
            />
            <p className={validWebhooks ? "text-muted-foreground text-xs" : "text-destructive text-xs"}>
              One HTTP(S) URL per line, up to 10. Payloads omit call arguments and credentials.
            </p>
          </div>
        </div>
      </CardContent>
      <CardFooter>
        <Button onClick={() => save.mutate()} disabled={disabled || !validWebhooks || save.isPending}>
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
      </CardFooter>
    </Card>
  )
}
