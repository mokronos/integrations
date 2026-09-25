import { Braces, Plug, Terminal } from "lucide-react"

import { AgentConnect } from "@/components/clients/agent-connect"
import { CopyField } from "@/components/ui/copy-field"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  cliConfiguration,
  cliInstallCommand,
  skillInstallCommand,
  tsClientExample,
  tsClientInstallCommand
} from "@/lib/connect"

export function ConnectTabs({ clientName, gatewayUrl, mcpUrl, apiKey }: {
  readonly clientName: string
  readonly gatewayUrl: string
  readonly mcpUrl: string
  readonly apiKey: string
}) {
  const configuration = cliConfiguration(gatewayUrl, apiKey)
  const example = tsClientExample(gatewayUrl, apiKey)
  return (
    <Tabs defaultValue="cli">
      <TabsList>
        <TabsTrigger value="cli"><Terminal />CLI + skill</TabsTrigger>
        <TabsTrigger value="mcp"><Plug />MCP</TabsTrigger>
        <TabsTrigger value="ts"><Braces />TypeScript</TabsTrigger>
      </TabsList>
      <TabsContent value="cli" className="space-y-3">
        <Step label="1. Install the CLI">
          <CopyField value={cliInstallCommand} label="Install command" />
        </Step>
        <Step label="2. Add the skill to your agent">
          <CopyField value={skillInstallCommand} label="Skill command" />
        </Step>
        <Step label="3. Point i at this gateway">
          <CopyField value={configuration} label="CLI configuration" multiline />
          <p className="text-muted-foreground text-xs">Set these in the environment your agent runs in. They take precedence over a local gateway.</p>
        </Step>
      </TabsContent>
      <TabsContent value="mcp">
        <AgentConnect clientName={clientName} url={mcpUrl} apiKey={apiKey} />
      </TabsContent>
      <TabsContent value="ts" className="space-y-3">
        <Step label="1. Install the client">
          <CopyField value={tsClientInstallCommand} label="Install command" />
        </Step>
        <Step label="2. Call the gateway">
          <CopyField value={example} label="TypeScript example" multiline />
        </Step>
      </TabsContent>
    </Tabs>
  )
}

function Step({ label, children }: {
  readonly label: string
  readonly children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm">{label}</p>
      {children}
    </div>
  )
}
