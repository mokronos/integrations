import { Plus } from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import { whenPresent } from "@integragents/contracts"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import * as gateway from "@/lib/gateway"
import { keys, useInvalidate, useMutation, useProfiles } from "@/lib/queries"

const EMPTY = "__empty__"

export function NewProfileDialog() {
  const navigate = useNavigate()
  const invalidate = useInvalidate()
  const profiles = (useProfiles().data ?? []).filter((entry) => entry.profile.revokedAt === null)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [source, setSource] = useState<string>(EMPTY)
  const copyFrom = profiles.find((entry) => entry.profile.id === source)?.profile.id
  const create = useMutation({
    mutationFn: () => gateway.createProfile({ name: name.trim(), ...whenPresent("copyFrom", copyFrom) }),
    onSuccess: (profile) => {
      invalidate(keys.profiles, keys.overview)
      setOpen(false)
      setName("")
      setSource(EMPTY)
      toast.success(`Created ${profile.name}`)
      void navigate(`/profiles/${profile.id}`)
    },
    onError: (error: Error) => toast.error("Could not create the profile", { description: error.message })
  })
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger render={<Button />}><Plus className="size-4" />New profile</DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>New profile</DialogTitle>
        <DialogDescription>A profile is what a set of AI apps may do. Apps you trust the same way can share one.</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (name.trim()) create.mutate() }}>
        <div className="space-y-1.5">
          <Label htmlFor="profile-name">Name</Label>
          <Input id="profile-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Coding agents" autoFocus />
        </div>
        <div className="space-y-1.5">
          <Label>Start from</Label>
          <Select
            className="w-full"
            value={source}
            onValueChange={(next) => setSource(next ?? EMPTY)}
            items={[
              { value: EMPTY, label: "Nothing, I'll choose tools" },
              ...profiles.map((entry) => ({ value: entry.profile.id, label: `A copy of ${entry.profile.name}` }))
            ]}
          />
          <p className="text-muted-foreground text-xs">A copy is independent: changing one never changes the other.</p>
        </div>
      </form>
      <DialogFooter>
        <Button disabled={name.trim().length === 0 || create.isPending} onClick={() => create.mutate()}>{create.isPending ? "Creating…" : "Create"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
