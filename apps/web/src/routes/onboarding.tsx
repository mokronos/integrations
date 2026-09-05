import { useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router"
import { ArrowLeft, ArrowRight, Check, CheckCircle2, KeyRound, Plug, ShieldCheck } from "lucide-react"
import { Option, Schema } from "effect"
import { ConnectionName, IntegrationSlug, ToolName } from "@mokronos/contracts"
import { createGatewayClient } from "@mokronos/integrations-client/client"

import { useSession } from "@/components/auth-gate"
import { ConnectDialog } from "@/components/integrations/connect-dialog"
import { DiscoverDialog } from "@/components/integrations/discover-dialog"
import { RegistrySearchDialog } from "@/components/integrations/registry-search-dialog"
import { LoadingRows, QueryError } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CopyField } from "@/components/ui/copy-field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import * as gateway from "@/lib/gateway"
import { apiKeyPlaceholder, mcpConfiguration } from "@/lib/mcp"
import { keys, useClients, useIntegrations, useInvalidate, useMcpUrl, useMutation, useQuery } from "@/lib/queries"
import type { Connection, IntegrationOverview } from "@/lib/schemas"

const Step = Schema.Literals(["connect", "access", "agent", "verify"])
type Step = typeof Step.Type
const steps: ReadonlyArray<{ readonly id: Step; readonly title: string }> = [
  { id: "connect", title: "Connect a service" },
  { id: "access", title: "Choose access" },
  { id: "agent", title: "Connect your agent" },
  { id: "verify", title: "Try it out" }
]

export function OnboardingRoute() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const session = useSession()
  const integrations = useIntegrations()
  const clients = useClients()
  const mcpUrl = useMcpUrl()
  const invalidate = useInvalidate()
  const step = Option.getOrElse(Schema.decodeUnknownOption(Step)(params.get("step")), () => "connect")
  const stepIndex = steps.findIndex((entry) => entry.id === step)
  const selected = integrations.data?.find((integration) => integration.slug === params.get("integration"))
  const connection = selected?.connections.find((entry) => entry.address === params.get("connection"))
  const client = clients.data?.find((entry) => entry.id === params.get("client") && entry.revokedAt === null && !entry.capabilities.includes("administer_gateway"))
  const [existingClient, setExistingClient] = useState("")

  const go = (next: Step, values: Readonly<Record<string, string>> = {}) => {
    setParams((current) => {
      const updated = new URLSearchParams(current)
      updated.set("step", next)
      for (const [key, value] of Object.entries(values)) updated.set(key, value)
      return updated
    })
  }
  const finish = () => {
    if (session?.authenticated) localStorage.setItem(`gateway-onboarding:${session.tenantId}`, "done")
    void navigate("/")
  }
  const issue = useMutation({
    mutationFn: (clientId: string) => gateway.issueKey(clientId),
    onSuccess: () => invalidate(keys.clients, keys.overview)
  })
  const secret = issue.variables === client?.id ? issue.data?.secret : undefined
  const verify = useMutation({
    mutationFn: async () => {
      if (secret === undefined) throw new Error("Issue a key in the previous step to verify access.")
      return createGatewayClient({ url: window.location.origin, apiKey: secret, fetch: (input, init) => fetch(input, { ...init, credentials: "omit" }) }).effectiveTools()
    }
  })
  const activity = useQuery({
    queryKey: ["onboarding-activity", client?.id],
    queryFn: () => gateway.listAudit({ clientId: client?.id ?? "", limit: 5, offset: 0 }),
    enabled: step === "verify" && client !== undefined,
    refetchInterval: 3_000
  })

  return <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-4 sm:px-6 sm:py-10">
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground text-sm font-medium">Getting started</span>
      <Button variant="ghost" size="sm" onClick={finish}>Set up later</Button>
    </div>
    <ol aria-label="Setup progress" className="grid grid-cols-4 gap-2">
      {steps.map((entry, index) => <li key={entry.id} aria-current={step === entry.id ? "step" : undefined} className="space-y-2">
        <div className={`h-1 rounded-full ${index <= stepIndex ? "bg-primary" : "bg-muted"}`} />
        <span className={`flex items-center gap-1.5 text-xs sm:text-sm ${step === entry.id ? "font-medium" : "text-muted-foreground"}`}>
          {index < stepIndex ? <Check className="size-3 shrink-0" /> : <span>{index + 1}.</span>}{entry.title}
        </span>
      </li>)}
    </ol>

    {step === "connect" ? <>
      <div className="space-y-3">
        <div className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-2xl"><Plug className="size-6" /></div>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Your accounts. Your agent. Your rules.</h1>
        <p className="text-muted-foreground max-w-xl text-base leading-relaxed">Start with one service. You’ll choose what your agent can do and which calls need your approval. The gateway holds the service’s credentials.</p>
      </div>
      <Card>
        <CardHeader><CardTitle>Connect your first service</CardTitle><CardDescription>Find a service, or add an MCP endpoint or OpenAPI document you already use.</CardDescription></CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap gap-2">
            <RegistrySearchDialog onInstalled={(slug) => go("connect", { integration: slug })} />
            <DiscoverDialog onInstalled={(slug) => go("connect", { integration: slug })} />
          </div>
          <QueryError error={integrations.error} />
          {integrations.isPending ? <LoadingRows rows={2} /> : integrations.data?.map((integration) => <div key={integration.slug} className={`space-y-3 rounded-xl border p-4 ${selected?.slug === integration.slug ? "border-primary/50 bg-primary/5" : ""}`}>
            <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-medium">{integration.name}</p><p className="text-muted-foreground text-sm">{integration.connections.length} connected accounts</p></div><ConnectDialog integration={integration} /></div>
            {integration.toolError ? <p role="alert" className="text-destructive text-sm">{integration.toolError}</p> : null}
            {integration.connections.filter((entry) => entry.owner === "org").map((entry) => <button key={entry.address} type="button" disabled={entry.status !== "connected"} onClick={() => go("access", { integration: integration.slug, connection: entry.address })} className="hover:bg-accent focus-visible:ring-ring flex w-full items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left text-sm outline-none focus-visible:ring-2 disabled:opacity-50">
              <span><span className="font-medium">{entry.identityLabel ?? entry.name}</span><span className="text-muted-foreground ml-2">{entry.status === "connected" ? "Connected" : "Reconnect to continue"}</span></span><ArrowRight className="size-4" />
            </button>)}
          </div>)}
        </CardContent>
      </Card>
      {(clients.data ?? []).some((entry) => entry.revokedAt === null && !entry.capabilities.includes("administer_gateway")) ? <div className="space-y-2 rounded-xl border border-dashed p-4">
        <Label htmlFor="existing-client">Already have a client? Continue with it.</Label>
        <div className="flex flex-wrap gap-2"><select id="existing-client" value={existingClient} onChange={(event) => setExistingClient(event.target.value)} className="bg-background min-w-0 flex-1 rounded-md border px-3 py-2 text-sm"><option value="">Choose a client</option>{clients.data?.filter((entry) => entry.revokedAt === null && !entry.capabilities.includes("administer_gateway")).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select><Button variant="outline" disabled={!existingClient} onClick={() => { issue.reset(); verify.reset(); go("agent", { client: existingClient }) }}>Use client</Button></div>
      </div> : null}
      <QueryError error={clients.error} />
    </> : null}

    {step === "access" ? selected !== undefined && connection !== undefined ? <AccessStep key={connection.address} integration={selected} connection={connection} onBack={() => go("connect")} onCreated={(id) => go("agent", { client: id })} /> : <Card><CardContent className="space-y-4 py-6"><p>Choose a connected account to set up access.</p><Button onClick={() => go("connect")}>Choose a service</Button></CardContent></Card> : null}

    {step === "agent" || step === "verify" ? (clients.isPending || (clients.isFetching && client === undefined)) ? <LoadingRows /> : client === undefined ? <Card><CardContent className="space-y-4 py-6"><p>This client is no longer available. Choose a client to continue.</p><Button onClick={() => go("connect")}>Choose a client</Button></CardContent></Card> : <>
      <div className="space-y-2"><h1 className="text-3xl font-semibold tracking-tight">{step === "agent" ? "Give your agent its own key." : "Make your first connection."}</h1><p className="text-muted-foreground">{step === "agent" ? `Connect ${client.name} to this gateway. Its key only permits the access you chose.` : "Verify the key, then ask your agent to use a connected tool."}</p></div>
      {step === "agent" ? <Card><CardContent className="space-y-5 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="flex items-center gap-2 font-medium"><KeyRound className="size-4" />Client key</p><p className="text-muted-foreground mt-1 text-sm">Shown once. Copy your configuration before leaving this page.</p></div><Button onClick={() => issue.mutate(client.id)} disabled={issue.isPending || secret !== undefined}>{issue.isPending ? "Issuing key…" : secret === undefined ? "Issue a key" : "Key issued"}</Button></div>
        <QueryError error={issue.error} />
        {secret !== undefined ? <CopyField value={secret} label="Client key" /> : null}
        <Tabs defaultValue="mcp"><TabsList><TabsTrigger value="mcp">MCP</TabsTrigger><TabsTrigger value="cli">CLI</TabsTrigger></TabsList>
          <TabsContent value="mcp" className="space-y-3"><p className="text-muted-foreground text-sm">Add this server to your agent’s MCP configuration.</p><QueryError error={mcpUrl.error} />{mcpUrl.data ? <CopyField value={mcpConfiguration(client.name, mcpUrl.data, secret ?? apiKeyPlaceholder)} label="MCP configuration" multiline /> : <p className="text-sm">The gateway needs a reachable public URL before it can provide an MCP configuration.</p>}</TabsContent>
          <TabsContent value="cli" className="space-y-3"><p className="text-muted-foreground text-sm">Install the CLI and set these variables in your agent’s environment.</p><CopyField value="bun add --global @mokronos/integrations-cli" label="Install command" /><CopyField value={`export INTEGRATIONS_URL=${JSON.stringify(window.location.origin)}\nexport INTEGRATIONS_API_KEY=${JSON.stringify(secret ?? apiKeyPlaceholder)}\ni --help`} label="CLI configuration" multiline /></TabsContent>
        </Tabs>
        <div className="flex justify-between"><Button variant="ghost" onClick={() => go("connect")}><ArrowLeft className="size-4" />Back</Button><Button disabled={secret === undefined} onClick={() => go("verify")}>Test the connection<ArrowRight className="size-4" /></Button></div>
      </CardContent></Card> : <>
        <Card><CardContent className="space-y-5 py-6">
          <div className="space-y-2"><p className="font-medium">1. Verify your agent’s access</p><p className="text-muted-foreground text-sm">Check that its key can list the tools you enabled.</p><Button variant="outline" disabled={verify.isPending || secret === undefined} onClick={() => verify.mutate()}>{verify.isPending ? "Checking…" : "Verify access"}</Button>{secret === undefined ? <Button variant="link" onClick={() => go("agent")}>Return to issue a key</Button> : null}<QueryError error={verify.error} />{verify.isSuccess ? <p role="status" className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4 text-primary" />Connected. {verify.data.tools.length} tools available to this client.</p> : null}</div>
          <div className="space-y-3 border-t pt-5"><p className="font-medium">2. Ask your agent to try a tool</p><CopyField value="List the tools available through my integrations gateway. Pick a read-only tool, explain what it will read, and call it. If approval is required, show me the approval link and wait for my decision." label="First task" multiline /><p className="text-muted-foreground text-sm">For an action that changes something, ask your agent to prepare the call. Review its exact arguments in <Link to="/approvals" target="_blank" className="text-foreground underline">Approvals</Link> before allowing it to run.</p></div>
          <div className="space-y-2 border-t pt-5"><p className="font-medium">Activity from {client.name}</p><QueryError error={activity.error} />{activity.data?.records.length ? activity.data.records.map((record) => <div key={record.id} className="flex items-center justify-between gap-3 text-sm"><code className="min-w-0 truncate">{record.tool ?? "Access check"}</code><Badge variant={record.outcome === "failed" || record.outcome === "denied" ? "destructive" : "secondary"}>{record.outcome}</Badge></div>) : <p className="text-muted-foreground text-sm">Waiting for your first call. This updates automatically.</p>}</div>
        </CardContent></Card>
        <div className="flex justify-between"><Button variant="ghost" onClick={() => go("agent")}><ArrowLeft className="size-4" />Configuration</Button><Button onClick={finish}>Open dashboard<ArrowRight className="size-4" /></Button></div>
      </>}
    </> : null}
  </div>
}

function AccessStep({ integration, connection, onBack, onCreated }: {
  readonly integration: IntegrationOverview
  readonly connection: Connection
  readonly onBack: () => void
  readonly onCreated: (clientId: string) => void
}) {
  const invalidate = useInvalidate()
  const [name, setName] = useState("")
  const [filter, setFilter] = useState("")
  const [enabled, setEnabled] = useState<ReadonlySet<string>>(new Set())
  const [reviewAll, setReviewAll] = useState(false)
  const tools = integration.tools.filter((tool) => tool.owner === connection.owner && tool.connection === connection.name)
  const selected = tools.filter((tool) => enabled.has(tool.name))
  const create = useMutation({
    mutationFn: () => gateway.createConfiguredClient({
      name: name.trim(),
      tools: selected.map((tool) => ({
        connection: { owner: "org", integration: IntegrationSlug.make(integration.slug), name: ConnectionName.make(connection.name) },
        tool: ToolName.make(tool.name),
        decision: reviewAll ? "require_approval" : tool.defaultDecision
      }))
    }),
    onSuccess: (client) => {
      invalidate(keys.clients, keys.accessProfiles, keys.approvalPolicies, keys.overview)
      onCreated(client.id)
    }
  })
  return <>
    <div className="space-y-2"><h1 className="text-3xl font-semibold tracking-tight">Give it just the access it needs.</h1><p className="text-muted-foreground">Choose tools on {integration.name} · {connection.identityLabel ?? connection.name}. You can change these choices later.</p></div>
    <Card><CardContent className="space-y-5 py-6">
      <div className="space-y-2"><Label htmlFor="onboarding-client-name">Name your client</Label><Input id="onboarding-client-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Research assistant" disabled={create.isPending} /></div>
      <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><Label htmlFor="onboarding-tool-filter">Tools it may use</Label><span className="text-muted-foreground text-xs">{selected.length} selected</span></div><Input id="onboarding-tool-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Find a tool…" /><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={create.isPending} onClick={() => setEnabled(new Set(tools.filter((tool) => tool.defaultDecision === "allow").map((tool) => tool.name)))}>Select read-only tools</Button><Button variant="ghost" size="sm" disabled={create.isPending} onClick={() => setEnabled(new Set())}>Clear selection</Button></div>
        <div className="max-h-72 divide-y overflow-y-auto rounded-lg border">{tools.filter((tool) => `${tool.name} ${tool.description}`.toLowerCase().includes(filter.toLowerCase())).map((tool) => <label key={tool.name} className="hover:bg-accent/40 flex cursor-pointer items-start gap-3 p-3"><input type="checkbox" checked={enabled.has(tool.name)} disabled={create.isPending} onChange={(event) => setEnabled((current) => { const next = new Set(current); if (event.target.checked) next.add(tool.name); else next.delete(tool.name); return next })} className="accent-primary mt-1 size-4 shrink-0" /><span className="min-w-0 flex-1"><span className="break-all font-mono text-xs">{tool.name}</span><span className="text-muted-foreground mt-1 block line-clamp-2 text-xs">{tool.description}</span></span><Badge variant="secondary">{reviewAll || tool.defaultDecision === "require_approval" ? "Approval" : "Read-only"}</Badge></label>)}{tools.length === 0 ? <p className="text-muted-foreground p-4 text-sm">No tools are available. Reconnect the service to continue.</p> : null}</div>
      </div>
      <div className="bg-muted/40 space-y-3 rounded-xl p-4"><p className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4" />You stay in control</p><p className="text-muted-foreground text-sm">Read-only tools can run directly. Other tools require your approval for each call. This client cannot manage the gateway or approve its own requests.</p><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reviewAll} disabled={create.isPending} onChange={(event) => setReviewAll(event.target.checked)} className="accent-primary size-4" />Ask me before every call, including reads</label></div>
      <QueryError error={create.error} />
      <div className="flex justify-between gap-3"><Button variant="ghost" onClick={onBack} disabled={create.isPending}><ArrowLeft className="size-4" />Back</Button><Button disabled={!name.trim() || selected.length === 0 || create.isPending} onClick={() => create.mutate()}>{create.isPending ? "Creating client…" : "Create client"}<ArrowRight className="size-4" /></Button></div>
    </CardContent></Card>
  </>
}
