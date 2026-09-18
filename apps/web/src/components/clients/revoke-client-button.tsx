import { toast } from "sonner"

import { ConfirmButton } from "@/components/ui/confirm-button"
import * as gateway from "@/lib/gateway"
import { keys, useInvalidate, useMutation } from "@/lib/queries"

export function RevokeClientButton({ clientId, clientName, onRevoked }: {
  readonly clientId: string
  readonly clientName: string
  readonly onRevoked?: () => void
}) {
  const invalidate = useInvalidate()
  const revoke = useMutation({
    mutationFn: () => gateway.revokeClient(clientId),
    onSuccess: (result) => {
      invalidate(keys.clients, keys.approvals("pending"), keys.overview)
      toast.success(`${clientName} revoked`, {
        description: result.cancelledApprovals === 0
          ? undefined
          : `${result.cancelledApprovals} pending approval${result.cancelledApprovals === 1 ? "" : "s"} cancelled.`
      })
      onRevoked?.()
    },
    onError: (error: Error) => toast.error("Could not revoke client", { description: error.message })
  })
  return (
    <ConfirmButton
      label="Revoke"
      title={`Revoke ${clientName}?`}
      description="Every API key stops working and pending approvals are cancelled. Tool access ends immediately. This cannot be undone."
      confirmLabel="Revoke"
      pendingLabel="Revoking…"
      pending={revoke.isPending}
      onConfirm={() => revoke.mutateAsync().then(() => undefined)}
    />
  )
}
