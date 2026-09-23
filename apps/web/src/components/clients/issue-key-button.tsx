import { KeyRound, Plug } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import type { ClientId } from "@integragents/contracts"

import { Button } from "@/components/ui/button"
import { CopyField } from "@/components/ui/copy-field"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import * as gateway from "@/lib/gateway"
import { mcpConfiguration } from "@/lib/mcp"
import { keys, useInvalidate, useMcpUrl, useMutation } from "@/lib/queries"

export function IssueKeyButton({ clientId, clientName, disabled, variant = "default" }: {
  readonly clientId: ClientId
  readonly clientName: string
  readonly disabled: boolean
  readonly variant?: "default" | "outline"
}) {
  const invalidate = useInvalidate()
  const mcpUrl = useMcpUrl().data
  const [secret, setSecret] = useState<string | undefined>()
  const issue = useMutation({
    mutationFn: () => gateway.issueKey(clientId),
    onSuccess: (issued) => {
      setSecret(issued.secret)
      invalidate(keys.apiKeys(clientId))
    },
    onError: (error: Error) => toast.error("Could not issue key", { description: error.message })
  })

  return (
    <>
      <Button size="sm" variant={variant} onClick={() => issue.mutate()} disabled={disabled || issue.isPending}>
        <KeyRound className="size-4" /> Issue key
      </Button>
      <Dialog open={secret !== undefined} onOpenChange={(next) => next ? undefined : setSecret(undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy this key now</DialogTitle>
            <DialogDescription>The gateway stores only its hash. The plaintext cannot be shown again.</DialogDescription>
          </DialogHeader>
          <CopyField value={secret ?? ""} label="Key" />
          {mcpUrl === undefined ? null : (
            <p className="text-muted-foreground text-xs">
              Or take it as MCP client configuration, with the key already in it.
            </p>
          )}
          <DialogFooter>
            {mcpUrl === undefined ? null : (
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(mcpConfiguration(clientName, mcpUrl, secret ?? ""))
                  toast.success("MCP configuration copied")
                }}
              >
                <Plug className="size-4" /> Copy MCP configuration
              </Button>
            )}
            <Button onClick={() => setSecret(undefined)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
