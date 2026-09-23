import { useState } from "react"
import { Copy, Plus } from "lucide-react"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import type { ConfigurationKind } from "@/components/policies/configuration-kinds"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { keys, useInvalidate, useMutation } from "@/lib/queries"

export function ConfigurationDialog<Id extends string>({ kind, source }: {
  readonly kind: ConfigurationKind<Id>
  readonly source?: { readonly id: Id; readonly name: string }
}) {
  const navigate = useNavigate()
  const invalidate = useInvalidate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(source === undefined ? "" : `${source.name} copy`)
  const mutation = useMutation({
    mutationFn: () => source === undefined ? kind.create(name.trim()) : kind.clone(source.id, name.trim()),
    onSuccess: (resource) => { invalidate(...kind.queryKeys(resource.id), keys.overview); setOpen(false); toast.success(`${source === undefined ? "Created" : "Cloned"} ${resource.name}`); void navigate(`${kind.path}/${resource.id}`) },
    onError: (error: Error) => toast.error(`Could not ${source === undefined ? "create" : "clone"} ${kind.label}`, { description: error.message })
  })
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger render={<Button variant={source === undefined ? "default" : "outline"} size={source === undefined ? "default" : "sm"} />}>{source === undefined ? <Plus className="size-4" /> : <Copy className="size-4" />}{source === undefined ? `New ${kind.label}` : "Clone"}</DialogTrigger><DialogContent><DialogHeader><DialogTitle>{source === undefined ? `New ${kind.label}` : `Clone ${source.name}`}</DialogTitle><DialogDescription>{source === undefined ? `Create a reusable ${kind.label}.` : "Create an independent copy of this configuration."}</DialogDescription></DialogHeader><div className="space-y-1.5"><Label htmlFor="configuration-name">Name</Label><Input id="configuration-name" value={name} onChange={(event) => setName(event.target.value)} /></div><DialogFooter><Button disabled={name.trim().length === 0 || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? "Saving..." : source === undefined ? "Create" : "Clone"}</Button></DialogFooter></DialogContent></Dialog>
}
