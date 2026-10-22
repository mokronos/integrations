import { Bell, Boxes, Braces, KeyRound, Laptop, Lock, Plug, Server, ShieldCheck, Terminal, Users } from "lucide-react"

export const REPO = "https://github.com/mokronos/integrations"
export const INSTALL = "curl -fsSL https://raw.githubusercontent.com/mokronos/integrations/main/install.sh | sh"
export const INSTALL_SKILL =
  "npx skills add https://github.com/mokronos/integrations/tree/main/.agents/skills/integrations -g"
export const QUICKSTART = [
  {
    n: "1",
    title: "Install and start",
    command: `${INSTALL}\nii install`
  },
  {
    n: "2",
    title: "Add the skill",
    command: INSTALL_SKILL
  },
  {
    n: "3",
    title: "Ask your agent",
    command: "Check my open linear issues"
  }
] as const

export interface Integration {
  readonly name: string
  readonly slug: string
  readonly hex: string
  readonly kind: string
}

export const INTEGRATIONS: ReadonlyArray<Integration> = [
  { name: "GitHub", slug: "github", hex: "181717", kind: "MCP · OAuth" },
  { name: "Gmail", slug: "gmail", hex: "EA4335", kind: "OpenAPI · OAuth" },
  { name: "Google Calendar", slug: "googlecalendar", hex: "4285F4", kind: "OpenAPI · OAuth" },
  { name: "Slack", slug: "slack", hex: "4A154B", kind: "OpenAPI · Token" },
  { name: "Discord", slug: "discord", hex: "5865F2", kind: "OpenAPI · Token" },
  { name: "Notion", slug: "notion", hex: "000000", kind: "OpenAPI · Token" },
  { name: "Linear", slug: "linear", hex: "5E6AD2", kind: "OpenAPI · Token" },
  { name: "Jira", slug: "jira", hex: "0052CC", kind: "OpenAPI · Token" },
  { name: "Asana", slug: "asana", hex: "F06A6A", kind: "OpenAPI · Token" },
  { name: "Trello", slug: "trello", hex: "0052CC", kind: "OpenAPI · Token" },
  { name: "Stripe", slug: "stripe", hex: "635BFF", kind: "OpenAPI · Token" },
  { name: "Figma", slug: "figma", hex: "F24E1E", kind: "OpenAPI · OAuth" },
  { name: "Salesforce", slug: "salesforce", hex: "00A1E0", kind: "OpenAPI · OAuth" },
  { name: "HubSpot", slug: "hubspot", hex: "FF7A59", kind: "OpenAPI · OAuth" },
  { name: "Zendesk", slug: "zendesk", hex: "03363D", kind: "OpenAPI · Token" }
]

export interface Step {
  readonly n: string
  readonly title: string
  readonly body: string
  readonly icon: typeof Plug
}

export const STEPS: ReadonlyArray<Step> = [
  {
    n: "01",
    title: "Install the gateway",
    body: "Download the standalone release, then run ii install. No Git, Bun, npm, or local build required.",
    icon: Server
  },
  {
    n: "02",
    title: "Add the agent skill",
    body: "Install the integrations skill globally. It teaches your agent the complete i workflow, from discovery through execution.",
    icon: Braces
  },
  {
    n: "03",
    title: "Ask for an outcome",
    body: "Tell your agent what you need in plain language. It uses i directly to find the service, connect it, inspect schemas, and call tools.",
    icon: Terminal
  },
  {
    n: "04",
    title: "Keep control",
    body: "Credentials stay in the gateway. Safe reads run immediately; writes and unknown operations wait for human approval.",
    icon: ShieldCheck
  }
]

export type CodeTab = "cli" | "gateway" | "mcp"

export const CODE_TABS: ReadonlyArray<{ readonly id: CodeTab; readonly label: string }> = [
  { id: "cli", label: "Agent CLI" },
  { id: "gateway", label: "Gateway flow" },
  { id: "mcp", label: "MCP endpoint" }
]

export const CODE_SNIPPETS = {
  cli: `# the skill teaches your agent this complete workflow
i integrations
i search linear
i discover https://mcp.linear.app/mcp
i connect mcp_linear_app
i tools mcp_linear_app --filter list_issues
# tools returns the exact alias and next schema command
# schema returns the exact next execute command`,
  gateway: `# agent harness -> sandbox -> client -> gateway -> integration
#                                        -> human (approval)

# safe reads run immediately, writes pause for a human:
#   {"status":"pending","approvalId":"approval_..."}
i approval approval_...`,
  mcp: `# any MCP-compatible client shares the same catalog
npx add-mcp http://127.0.0.1:4788/mcp --transport http --name integrations

# tools surface:  <connection-alias>__<tool-name>
#   org_github_work__createIssue
# discovery surface: search, discover, connect, execute, approval`
} as const satisfies Record<CodeTab, string>

export interface Deployment {
  readonly title: string
  readonly tag?: string
  readonly body: string
  readonly command: string
  readonly icon: typeof Lock
}

export const DEPLOYMENTS: ReadonlyArray<Deployment> = [
  {
    title: "Local",
    tag: "Recommended",
    body: "A per-user service on Linux or macOS. It survives reboots, keeps state in ~/.integrations, and the CLI finds it with no configuration.",
    command: "ii install",
    icon: Laptop
  },
  {
    title: "Self-hosted",
    body: "The same binary on a server you control, behind TLS. Every machine and teammate shares one catalog, one set of credentials, one audit trail.",
    command: "ii serve --host 0.0.0.0",
    icon: Server
  },
  {
    title: "Embedded",
    body: "Run gateway-core in-process on your application's own database, with the same policy, approval, and audit path.",
    command: "bun add @integragents/gateway-core",
    icon: Boxes
  }
]

export interface Feature {
  readonly title: string
  readonly body: string
  readonly icon: typeof Lock
}

export const FEATURES: ReadonlyArray<Feature> = [
  {
    title: "Credentials never leave the gateway",
    body: "OAuth grants, API keys, and bearer tokens are held server-side. Each app gets its own API key and invokes logical { alias, tool } addresses.",
    icon: Lock
  },
  {
    title: "Profiles, not pasted keys",
    body: "A profile is the tools an agent may call. Claude Code, ChatGPT, and Gemini CLI can share one, each with its own revocable key.",
    icon: Users
  },
  {
    title: "Off, Ask, or Allow for every tool",
    body: "Read-only tools run immediately; mutating or unclassified tools ask first. Change them in bulk, per integration or tool.",
    icon: ShieldCheck
  },
  {
    title: "Human-in-the-loop that can't be gamed",
    body: "Approvals surface in the dashboard, over a link, or via webhook — and the model can never approve its own request.",
    icon: Bell
  },
  {
    title: "OAuth delegation for your users",
    body: "Act for the person the agent serves, not the org. First call starts a bound OAuth flow; a leaked URL can only finish that person's connection.",
    icon: KeyRound
  },
  {
    title: "Local first, yours to host",
    body: "Runs as a service on your machine by default. Self-host it for a team, or embed gateway-core in-process on your own database.",
    icon: Server
  }
]
