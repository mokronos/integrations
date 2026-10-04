import { useState } from "react"
import { toast } from "sonner"
import type { ApiKeyView, OAuthGrantView, Profile } from "@integragents/contracts"

import { LoadingRows } from "@/components/page"
import { AddAppButton } from "@/components/profiles/add-app-button"
import { ConnectTabs } from "@/components/profiles/connect-tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { ConfirmButton } from "@/components/ui/confirm-button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { when } from "@/lib/format"
import * as gateway from "@/lib/gateway"
import { apiKeyPlaceholder } from "@/lib/mcp"
import { keys, useApiKeys, useGatewayUrl, useInvalidate, useMcpUrl, useMutation, useOAuthGrants } from "@/lib/queries"

type AppRow =
  | { readonly kind: "key"; readonly key: ApiKeyView }
  | { readonly kind: "oauth"; readonly grant: OAuthGrantView }

const rowRevoked = (row: AppRow): boolean =>
  row.kind === "key" ? row.key.revokedAt !== null : row.grant.revokedAt !== null

function RevokeApp({ row, profile }: { readonly row: AppRow; readonly profile: Profile }) {
  const invalidate = useInvalidate()
  const name = row.kind === "key" ? row.key.name : row.grant.applicationName
  const revoke = useMutation({
    mutationFn: () => row.kind === "key"
      ? gateway.revokeKey(row.key.id).then(() => undefined)
      : gateway.revokeOAuthGrant(row.grant.id).then(() => undefined),
    onSuccess: () => {
      invalidate(keys.apiKeys(profile.id), keys.oauthGrants, keys.profiles)
      toast.success(`${name} can no longer call this profile`)
    },
    onError: (error: Error) => toast.error("Could not revoke access", { description: error.message })
  })
  return <ConfirmButton
    label="Revoke"
    title={`Revoke ${name}?`}
    description={row.kind === "key"
      ? "This key stops working immediately. Other apps on this profile keep their access."
      : "Its access and refresh tokens stop working immediately. Other apps on this profile keep their access."}
    confirmLabel="Revoke"
    pendingLabel="Revoking…"
    pending={revoke.isPending}
    onConfirm={() => revoke.mutateAsync()}
  />
}

export function ProfileApps({ profile }: { readonly profile: Profile }) {
  const apiKeys = useApiKeys(profile.id)
  const grants = useOAuthGrants()
  const gatewayUrl = useGatewayUrl()
  const mcpUrl = useMcpUrl()
  const [showRevoked, setShowRevoked] = useState(false)
  const rows: ReadonlyArray<AppRow> = [
    ...(grants.data ?? []).filter((grant) => grant.profileId === profile.id).map((grant) => ({ kind: "oauth" as const, grant })),
    ...(apiKeys.data ?? []).map((key) => ({ kind: "key" as const, key }))
  ]
  const live = rows.filter((row) => !rowRevoked(row))
  const revoked = rows.length - live.length
  const shown = showRevoked ? rows : live

  return <div className="space-y-4">
    <Card>
      <CardHeader>
        <CardTitle>Apps using this profile</CardTitle>
        <CardDescription>
          Every app has its own key or OAuth grant. Calls are recorded under its name, and revoking one leaves the others working.
        </CardDescription>
        <CardAction><AddAppButton profile={profile} variant={live.length === 0 ? "default" : "outline"} /></CardAction>
      </CardHeader>
      <CardContent className="p-0">
        {apiKeys.isPending || grants.isPending ? <div className="p-4"><LoadingRows rows={2} /></div> : <Table>
          <TableHeader><TableRow><TableHead>App</TableHead><TableHead>Connected with</TableHead><TableHead>Added</TableHead><TableHead>Last used</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {shown.length === 0
              ? <TableRow><TableCell colSpan={5} className="text-muted-foreground py-8 text-center">No app is connected yet. Add one with a key, or authorize it through MCP below.</TableCell></TableRow>
              : shown.map((row) => <TableRow key={row.kind === "key" ? row.key.id : row.grant.id} className={rowRevoked(row) ? "opacity-55" : undefined}>
                <TableCell className="font-medium">{row.kind === "key" ? row.key.name : row.grant.applicationName}</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {row.kind === "key" ? "API key" : `Browser login by ${row.grant.subjectEmail}`}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">{when(row.kind === "key" ? row.key.createdAt : row.grant.createdAt)}</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {(row.kind === "key" ? row.key.lastUsedAt : row.grant.lastUsedAt) === null ? "Never" : when(row.kind === "key" ? row.key.lastUsedAt : row.grant.lastUsedAt)}
                </TableCell>
                <TableCell className="text-right">
                  {rowRevoked(row) ? <Badge variant="outline">revoked</Badge> : <RevokeApp row={row} profile={profile} />}
                </TableCell>
              </TableRow>)}
          </TableBody>
        </Table>}
      </CardContent>
      {revoked === 0 ? null : (
        <CardFooter>
          <Button variant="ghost" size="sm" onClick={() => setShowRevoked((value) => !value)}>
            {showRevoked ? "Hide revoked" : `Show ${revoked} revoked`}
          </Button>
        </CardFooter>
      )}
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Connect an app</CardTitle>
        <CardDescription>Through MCP with a browser login, the CLI and skill, or the TypeScript client.</CardDescription>
      </CardHeader>
      <CardContent>
        {gatewayUrl.isPending || mcpUrl.isPending
          ? <LoadingRows rows={2} />
          : gatewayUrl.data === undefined || mcpUrl.data === undefined
          ? <p className="text-muted-foreground text-sm">
            This gateway has no public URL to name. Start it on loopback, or set
            <code className="mx-1 font-mono text-xs">INTEGRATIONS_PUBLIC_URL</code>
            to the address agents reach it at.
          </p>
          : <ConnectTabs profileName={profile.name} gatewayUrl={gatewayUrl.data} mcpUrl={mcpUrl.data} apiKey={apiKeyPlaceholder} />}
      </CardContent>
    </Card>
  </div>
}
