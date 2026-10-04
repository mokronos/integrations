import { KeyRound, Plug } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import type { Profile } from "@integragents/contracts"

import { Button } from "@/components/ui/button"
import { CopyField } from "@/components/ui/copy-field"
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
import { mcpConfiguration } from "@/lib/mcp"
import { keys, useInvalidate, useMcpUrl, useMutation } from "@/lib/queries"

/** Issues one app its own key, named after the app, so its calls are attributed and it can be cut off alone. */
export function AddAppButton({ profile, variant = "default" }: {
  readonly profile: Profile
  readonly variant?: "default" | "outline"
}) {
  const invalidate = useInvalidate()
  const mcpUrl = useMcpUrl().data
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const issue = useMutation({
    mutationFn: () => gateway.issueKey(profile.id, name.trim()),
    onSuccess: () => invalidate(keys.apiKeys(profile.id), keys.profiles, keys.overview),
    onError: (error: Error) => toast.error("Could not issue a key", { description: error.message })
  })
  const secret = issue.data?.secret
  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (!next) {
      issue.reset()
      setName("")
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button size="sm" variant={variant} disabled={profile.revokedAt !== null} />}>
        <KeyRound className="size-4" /> Add an app
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{secret === undefined ? "Add an app with an API key" : "Copy this key now"}</DialogTitle>
          <DialogDescription>
            {secret === undefined
              ? "Each app gets its own key. Its calls show up under this name, and revoking it cuts off only this app."
              : "The gateway stores only its hash. The key cannot be shown again."}
          </DialogDescription>
        </DialogHeader>
        {secret === undefined
          ? (
            <form className="space-y-1.5" onSubmit={(event) => { event.preventDefault(); if (name.trim()) issue.mutate() }}>
              <Label htmlFor="app-name">App name</Label>
              <Input id="app-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Claude Code" autoFocus />
            </form>
          )
          : <CopyField value={secret} label="Key" />}
        <DialogFooter>
          {secret === undefined
            ? <Button onClick={() => issue.mutate()} disabled={name.trim().length === 0 || issue.isPending}>{issue.isPending ? "Issuing…" : "Issue key"}</Button>
            : <>
              {mcpUrl === undefined ? null : (
                <Button
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard.writeText(mcpConfiguration(name, mcpUrl, secret))
                    toast.success("MCP configuration copied")
                  }}
                >
                  <Plug className="size-4" /> Copy MCP configuration
                </Button>
              )}
              <Button onClick={() => changeOpen(false)}>Done</Button>
            </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
