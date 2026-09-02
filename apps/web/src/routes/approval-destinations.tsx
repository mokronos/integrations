import { useState } from "react"
import { Bell, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Page, QueryError } from "@/components/page"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import * as gateway from "@/lib/gateway"
import { keys, useApprovalDestinations, useInvalidate, useMutation } from "@/lib/queries"

function CreateDestination() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const invalidate = useInvalidate()
  const create = useMutation({
    mutationFn: () => gateway.createApprovalDestination({ name: name.trim(), url: url.trim() }),
    onSuccess: (created) => {
      invalidate(keys.approvalDestinations)
      setOpen(false)
      toast.success("Destination created", { description: `Copy this signing secret now: ${created.signingSecret}`, duration: 30_000 })
    },
    onError: (error: Error) => toast.error("Could not create destination", { description: error.message })
  })
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button>New destination</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>Webhook destination</DialogTitle><DialogDescription>The secret is shown once. Use it to verify every notification signature.</DialogDescription></DialogHeader><div className="space-y-4"><div><Label htmlFor="destination-name">Name</Label><Input id="destination-name" value={name} onChange={(event) => setName(event.target.value)} /></div><div><Label htmlFor="destination-url">Public HTTPS URL</Label><Input id="destination-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/approval-events" /></div></div><DialogFooter><Button disabled={!name.trim() || !url.trim() || create.isPending} onClick={() => create.mutate()}>Create</Button></DialogFooter></DialogContent></Dialog>
}

export function ApprovalDestinationsRoute() {
  const query = useApprovalDestinations()
  const invalidate = useInvalidate()
  const remove = useMutation({ mutationFn: gateway.deleteApprovalDestination, onSuccess: () => invalidate(keys.approvalDestinations), onError: (error: Error) => toast.error("Could not delete destination", { description: error.message }) })
  return <Page title="Approval destinations" description="Reusable notification endpoints. A notification announces a pending decision but never carries authority to make it." actions={<CreateDestination />}><QueryError error={query.error} /><div className="space-y-3">{(query.data ?? []).map((destination) => <Card key={destination.id}><CardContent className="flex items-center gap-3 p-4"><Bell className="size-4" /><div className="min-w-0 flex-1"><p className="font-medium">{destination.name}</p><p className="text-muted-foreground truncate text-xs">{destination.url}</p></div><Button variant="ghost" size="icon" aria-label={`Delete ${destination.name}`} onClick={() => remove.mutate(destination.id)}><Trash2 /></Button></CardContent></Card>)}</div></Page>
}
