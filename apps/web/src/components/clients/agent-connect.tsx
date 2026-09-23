import { ChevronRight, Plug } from "lucide-react"

import { IntegrationIcon } from "@/components/integrations/integration-icon"
import { CopyField } from "@/components/ui/copy-field"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { agentSetup, mcpConfiguration, mcpOAuthConfiguration } from "@/lib/mcp"
import type { CodingAgent, Snippet } from "@/lib/mcp"

const agents: ReadonlyArray<{ readonly id: CodingAgent; readonly label: string; readonly host: string }> = [
  { id: "claude", label: "Claude Code", host: "claude.ai" },
  { id: "codex", label: "Codex", host: "openai.com" },
  { id: "opencode", label: "OpenCode", host: "opencode.ai" }
]

export function AgentConnect({ clientName, url, apiKey }: {
  readonly clientName: string
  readonly url: string
  readonly apiKey: string
}) {
  return (
    <Tabs defaultValue="claude">
      <TabsList>
        {agents.map((agent) => (
          <TabsTrigger key={agent.id} value={agent.id}>
            <IntegrationIcon host={agent.host} size={14} />
            {agent.label}
          </TabsTrigger>
        ))}
        <TabsTrigger value="other"><Plug />Other</TabsTrigger>
      </TabsList>
      {agents.map((agent) => {
        const setup = agentSetup(agent.id, clientName, url, apiKey)
        return (
          <TabsContent key={agent.id} value={agent.id} className="space-y-2">
            {setup.browserLogin.map((snippet) => <SnippetField key={snippet.label} snippet={snippet} />)}
            <p className="text-muted-foreground text-xs">{setup.browserLoginHint} You will choose the Gateway Client during authorization.</p>
            <ApiKeyAlternative snippet={setup.apiKey} />
          </TabsContent>
        )
      })}
      <TabsContent value="other" className="space-y-2">
        <SnippetField snippet={{ label: "Browser login configuration", value: mcpOAuthConfiguration(url) }} />
        <p className="text-muted-foreground text-xs">For MCP clients that support OAuth. You will choose the Gateway Client during authorization.</p>
        <ApiKeyAlternative snippet={{ label: "API key configuration", value: mcpConfiguration(clientName, url, apiKey) }} />
      </TabsContent>
    </Tabs>
  )
}

function SnippetField({ snippet }: { readonly snippet: Snippet }) {
  return <CopyField value={snippet.value} label={snippet.label} multiline={snippet.value.includes("\n")} />
}

function ApiKeyAlternative({ snippet }: { readonly snippet: Snippet }) {
  return (
    <details className="group pt-1">
      <summary className="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer list-none items-center gap-1 text-xs [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
        Use an API key instead, for headless agents
      </summary>
      <div className="mt-2">
        <SnippetField snippet={snippet} />
      </div>
    </details>
  )
}
