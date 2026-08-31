import { useState } from "react"
import { Copy, Plus } from "lucide-react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import * as gateway from "@/lib/gateway"
import { keys, useInvalidate, useMutation } from "@/lib/queries"

export function CreatePolicyDialog() {
  const navigate = useNavigate()
  const invalidate = useInvalidate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const create = useMutation({
    mutationFn: () => gateway.createPolicy({ name: name.trim() }),
    onSuccess: (policy) => {
      invalidate(keys.policies, keys.overview)
      setOpen(false)
      setName("")
      toast.success(`Created ${policy.name}`)
      void navigate(`/policies/${policy.id}`)
    },
    onError: (error: Error) => toast.error("Could not create policy", { description: error.message })
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="size-4" />New policy</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New policy</DialogTitle>
          <DialogDescription>Create an empty policy, then choose its complete tool set.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="policy-name">Name</Label>
          <Input
            id="policy-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Research tools"
          />
        </div>
        <DialogFooter>
          <Button disabled={name.trim().length === 0 || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Creating…" : "Create policy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ClonePolicyDialog({
  policyId,
  policyName,
  clientId
}: {
  readonly policyId: string
  readonly policyName: string
  readonly clientId?: string
}) {
  const navigate = useNavigate()
  const invalidate = useInvalidate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(`${policyName} copy`)
  const clone = useMutation({
    mutationFn: async () => {
      const result = await gateway.clonePolicy({ policyId, name: name.trim() })
      if (clientId !== undefined) {
        await gateway.assignPolicy({ clientId, policyId: result.policy.id })
      }
      return result
    },
    onSuccess: (result) => {
      invalidate(keys.policies, keys.clients, keys.overview)
      setOpen(false)
      toast.success(clientId === undefined ? "Policy cloned" : "Policy cloned and assigned")
      void navigate(`/policies/${result.policy.id}`)
    },
    onError: (error: Error) => toast.error("Could not clone policy", { description: error.message })
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size={clientId === undefined ? "sm" : "default"}>
          <Copy className="size-4" />
          {clientId === undefined ? "Clone" : "Customize for this client"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{clientId === undefined ? `Clone ${policyName}` : `Customize ${policyName} for this client`}</DialogTitle>
          <DialogDescription>
            {clientId === undefined
              ? "The new policy starts with the same complete tool set."
              : "The clone will be assigned to this client, isolating future edits from other clients."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={`clone-name-${policyId}`}>Name</Label>
          <Input
            id={`clone-name-${policyId}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button disabled={name.trim().length === 0 || clone.isPending} onClick={() => clone.mutate()}>
            {clone.isPending ? "Cloning…" : clientId === undefined ? "Clone policy" : "Create private policy and assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
