import { Plug } from "lucide-react"

import { LoadingRows } from "@/components/page"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { CopyField } from "@/components/ui/copy-field"
import { apiKeyPlaceholder, mcpConfiguration } from "@/lib/mcp"
import { useMcpUrl } from "@/lib/queries"

/** What an agent needs to reach this client's tools over MCP.
 *
 *  This lives on the client rather than on a page of its own because both
 *  halves of the answer are the client's: the endpoint is the same for
 *  everyone, but what it exposes is this client's effective tools and the
 *  credential that selects them is this client's API key. A copy button
 *  anywhere else would be half an answer. */
export function ClientMcp({ clientName }: { readonly clientName: string }) {
  const mcpUrl = useMcpUrl()
  const url = mcpUrl.data

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Plug className="size-4" /> Connect over MCP</CardTitle>
        <CardDescription>
          An MCP client reaches the gateway at one endpoint and identifies itself with
          one of this client's API keys. It sees exactly the effective tools below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {mcpUrl.isPending
          ? <LoadingRows rows={3} />
          : url === undefined
          ? <p className="text-muted-foreground text-sm">
            This gateway has no public URL to name. Start it on loopback, or set
            <code className="mx-1 font-mono text-xs">INTEGRATIONS_PUBLIC_URL</code>
            to the address agents reach it at.
          </p>
          : <>
            <Field label="Endpoint">
              <CopyField value={url} label="Endpoint" />
            </Field>
            <Field
              label="Authorization"
              hint="Issue a key above and paste it in place of the placeholder. The gateway keeps only its hash, so the plaintext is shown once."
            >
              <CopyField value={`Authorization: Bearer ${apiKeyPlaceholder}`} label="Authorization header" />
            </Field>
            <Field label="Client configuration">
              <CopyField
                value={mcpConfiguration(clientName, url, apiKeyPlaceholder)}
                label="Configuration"
                multiline
              />
            </Field>
          </>}
      </CardContent>
    </Card>
  )
}

function Field({ label, hint, children }: {
  readonly label: string
  readonly hint?: string
  readonly children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      {children}
      {hint === undefined ? null : <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  )
}
