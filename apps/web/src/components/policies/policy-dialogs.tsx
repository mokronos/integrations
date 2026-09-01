import { useState } from "react"
import { Copy, Plus } from "lucide-react"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import * as gateway from "@/lib/gateway"
import { keys, useInvalidate, useMutation } from "@/lib/queries"

export function ConfigurationDialog({ kind, source }: { readonly kind: "access-profile" | "approval-policy"; readonly source?: { readonly id: string; readonly name: string } }) {
  const plural = kind === "access-profile" ? "access-profiles" : "approval-policies"
  const label = kind === "access-profile" ? "access profile" : "approval policy"
  const navigate = useNavigate()
  const invalidate = useInvalidate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(source === undefined ? "" : `${source.name} copy`)
  const mutation = useMutation({
    mutationFn: async (): Promise<{ readonly id: string; readonly name: string }> => source === undefined
      ? kind === "access-profile" ? gateway.createAccessProfile(name.trim()) : gateway.createApprovalPolicy(name.trim())
      : kind === "access-profile" ? gateway.cloneAccessProfile(source.id, name.trim()).then((value) => value.accessProfile) : gateway.cloneApprovalPolicy(source.id, name.trim()).then((value) => value.approvalPolicy),
    onSuccess: (resource) => { invalidate(kind === "access-profile" ? keys.accessProfiles : keys.approvalPolicies, keys.overview); setOpen(false); toast.success(`${source === undefined ? "Created" : "Cloned"} ${resource.name}`); void navigate(`/${plural}/${resource.id}`) },
    onError: (error: Error) => toast.error(`Could not ${source === undefined ? "create" : "clone"} ${label}`, { description: error.message })
  })
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant={source === undefined ? "default" : "outline"} size={source === undefined ? "default" : "sm"}>{source === undefined ? <Plus className="size-4" /> : <Copy className="size-4" />}{source === undefined ? `New ${label}` : "Clone"}</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>{source === undefined ? `New ${label}` : `Clone ${source.name}`}</DialogTitle><DialogDescription>{source === undefined ? `Create a reusable ${label}.` : "Create an independent copy of this configuration."}</DialogDescription></DialogHeader><div className="space-y-1.5"><Label htmlFor={`${kind}-name`}>Name</Label><Input id={`${kind}-name`} value={name} onChange={(event) => setName(event.target.value)} /></div><DialogFooter><Button disabled={name.trim().length === 0 || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? "Saving..." : source === undefined ? "Create" : "Clone"}</Button></DialogFooter></DialogContent></Dialog>
}
