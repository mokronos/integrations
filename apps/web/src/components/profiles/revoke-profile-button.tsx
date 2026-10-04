import { toast } from "sonner"
import type { Profile } from "@integragents/contracts"

import { ConfirmButton } from "@/components/ui/confirm-button"
import * as gateway from "@/lib/gateway"
import { keys, useInvalidate, useMutation } from "@/lib/queries"

export function RevokeProfileButton({ profile, onRevoked }: {
  readonly profile: Profile
  readonly onRevoked?: () => void
}) {
  const invalidate = useInvalidate()
  const revoke = useMutation({
    mutationFn: () => gateway.revokeProfile(profile.id),
    onSuccess: (result) => {
      invalidate(keys.profiles, ["approvals"], keys.overview)
      toast.success(`${profile.name} revoked`, {
        description: result.cancelledApprovals === 0
          ? undefined
          : `${result.cancelledApprovals} pending approval${result.cancelledApprovals === 1 ? "" : "s"} cancelled.`
      })
      onRevoked?.()
    },
    onError: (error: Error) => toast.error("Could not revoke the profile", { description: error.message })
  })
  return (
    <ConfirmButton
      label="Revoke"
      title={`Revoke ${profile.name}?`}
      description="Every app on this profile loses access at once, and its pending approvals are cancelled. This cannot be undone."
      confirmLabel="Revoke"
      pendingLabel="Revoking…"
      pending={revoke.isPending}
      onConfirm={() => revoke.mutateAsync().then(() => undefined)}
    />
  )
}
