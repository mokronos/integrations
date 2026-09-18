import { useState } from "react"
import {
  ArrowRight,
  Bell,
  Braces,
  Check,
  Copy,
  FileText,
  Globe,
  KeyRound,
  Layers,
  Lock,
  Plug,
  Search,
  Server,
  ShieldCheck,
  Terminal,
  Users,
  Zap
} from "lucide-react"

const REPO = "https://github.com/mokronos/integrations"
const INSTALL =
  "curl -fsSL https://github.com/mokronos/integrations/releases/latest/download/install.sh | sh"
const INSTALL_SKILL =
  "npx skills add https://github.com/mokronos/integrations/tree/main/.agents/skills/integrations -g"
const QUICKSTART = [
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
    command: "Use integrations to connect Linear and list my open issues."
  }
] as const

interface Integration {
  readonly name: string
  readonly slug: string
  readonly hex: string
  readonly kind: string
}

const INTEGRATIONS: ReadonlyArray<Integration> = [
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

interface Step {
  readonly n: string
  readonly title: string
  readonly body: string
  readonly icon: typeof Plug
}

const STEPS: ReadonlyArray<Step> = [
  {
    n: "01",
    title: "Install the gateway",
    body: "Install the release, then run ii install. The local service keeps credentials and enforces policy for every call.",
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

type CodeTab = "cli" | "gateway" | "mcp"

const CODE_TABS: ReadonlyArray<{ readonly id: CodeTab; readonly label: string }> = [
  { id: "cli", label: "Agent CLI" },
  { id: "gateway", label: "Gateway flow" },
  { id: "mcp", label: "MCP endpoint" }
]

const CODE_SNIPPETS = {
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

interface Feature {
  readonly title: string
  readonly body: string
  readonly icon: typeof Lock
}

const FEATURES: ReadonlyArray<Feature> = [
  {
    title: "Credentials never leave the gateway",
    body: "OAuth grants, API keys, and bearer tokens are held server-side. Clients get an API key and invoke logical { alias, tool } addresses.",
    icon: Lock
  },
  {
    title: "Access profiles, not pasted keys",
    body: "Reusable sets of connections and tools granted per client. A rule for a connection a client was never granted reaches nothing.",
    icon: Users
  },
  {
    title: "Approval policies with safe defaults",
    body: "Read-only tools run immediately; mutating or unclassified tools require approval. Manage decisions in bulk, per integration or tool.",
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
    title: "Embeddable where you already run",
    body: "Run the hosted gateway, the local Bun service, a Cloudflare Worker — or embed gateway-core in-process on your own database.",
    icon: Server
  }
]

function GithubMark({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

function BrandIcon({ slug, hex, name }: { slug: string; hex: string; name: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-white text-lg font-bold text-neutral-900">
      {failed ? (
        <span aria-hidden>{name.slice(0, 1)}</span>
      ) : (
        <img
          src={`https://cdn.simpleicons.org/${slug}/${hex}`}
          alt=""
          loading="lazy"
          width={28}
          height={28}
          className="size-7"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        if (navigator.clipboard === undefined) return
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1600)
          })
          .catch(() => undefined)
      }}
      className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/5 text-neutral-400 transition hover:bg-white/10 hover:text-white"
      aria-label="Copy to clipboard"
    >
      {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
    </button>
  )
}

function Nav() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/5 bg-black/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <a href="#top" className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg border border-orange-500/40 bg-orange-500/10">
            <Plug className="size-4 text-orange-400" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">integrations</span>
        </a>
        <nav className="hidden items-center gap-7 text-sm text-neutral-400 md:flex">
          <a href="#integrations" className="transition hover:text-white">
            Integrations
          </a>
          <a href="#how" className="transition hover:text-white">
            How it works
          </a>
          <a href="#code" className="transition hover:text-white">
            Code
          </a>
          <a href="#features" className="transition hover:text-white">
            Features
          </a>
          <a href="#security" className="transition hover:text-white">
            Security
          </a>
        </nav>
        <div className="flex items-center gap-3">
          <a
            href={REPO}
            className="hidden items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3.5 py-2 text-sm font-medium transition hover:bg-white/10 sm:flex"
          >
            <GithubMark className="size-4" />
            GitHub
          </a>
          <a
            href="#get-started"
            className="flex items-center gap-1.5 rounded-lg bg-orange-500 px-3.5 py-2 text-sm font-semibold text-black transition hover:bg-orange-400"
          >
            Get started
            <ArrowRight className="size-4" />
          </a>
        </div>
      </div>
    </header>
  )
}

function Hero() {
  return (
    <section className="relative overflow-hidden pt-36 pb-20">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 45% at 50% -5%, rgba(249,115,22,0.22), transparent), radial-gradient(ellipse 40% 35% at 80% 20%, rgba(99,102,241,0.12), transparent)"
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(ellipse 70% 60% at 50% 0%, black, transparent)"
        }}
      />
      <div className="relative mx-auto max-w-6xl px-6 text-center">
        <a
          href="#integrations"
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-[13px] text-neutral-300 transition hover:border-orange-500/40 hover:text-white"
        >
          <span className="size-1.5 rounded-full bg-emerald-400" style={{ animation: "pulse-glow 2s infinite" }} />
          OpenAPI · MCP · OAuth — one catalog for every agent
        </a>
        <h1 className="mx-auto mt-7 max-w-3xl text-5xl font-semibold tracking-tighter text-balance sm:text-6xl">
          Give your agent every API. <span className="text-orange-400">Just ask.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-pretty text-neutral-400">
          Install the gateway, add one skill, and your agent uses the
          <span className="font-mono text-[0.9em] text-neutral-200"> i</span> CLI directly to
          discover, connect, and call external services under your policies.
        </p>
        <div className="mx-auto mt-9 max-w-4xl overflow-hidden rounded-2xl border border-white/10 bg-neutral-950/90 text-left shadow-2xl shadow-orange-500/5">
          <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
            <Terminal className="size-4 text-orange-400" />
            <span className="text-sm font-semibold">Local quickstart</span>
            <span className="ml-auto text-xs text-neutral-500">Linux · macOS</span>
          </div>
          <div className="divide-y divide-white/5">
            {QUICKSTART.map((step) => (
              <div key={step.n} className="flex items-start gap-3 px-4 py-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-orange-500/15 font-mono text-xs font-semibold text-orange-300">
                  {step.n}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-neutral-400">{step.title}</p>
                  <code className="mt-1 block whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-neutral-200">
                    {step.command}
                  </code>
                </div>
                <CopyButton text={step.command} />
              </div>
            ))}
          </div>
        </div>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <a
            href="#get-started"
            className="flex items-center gap-2 rounded-xl bg-orange-500 px-6 py-3 font-semibold text-black transition hover:bg-orange-400"
          >
            Get started
            <ArrowRight className="size-4" />
          </a>
          <a
            href={REPO}
            className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-6 py-3 font-medium transition hover:bg-white/10"
          >
            <GithubMark className="size-4" />
            View on GitHub
          </a>
        </div>
        <dl className="mx-auto mt-12 grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            { icon: Globe, k: "Any API", v: "OpenAPI specs + MCP servers" },
            { icon: Lock, k: "Zero key sprawl", v: "Gateway holds all credentials" },
            { icon: ShieldCheck, k: "Governed tools", v: "Access + approval policies" }
          ].map((stat) => (
            <div
              key={stat.k}
              className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3.5 text-left"
            >
              <stat.icon className="size-5 shrink-0 text-orange-400" />
              <div>
                <dt className="text-sm font-semibold">{stat.k}</dt>
                <dd className="text-[13px] text-neutral-400">{stat.v}</dd>
              </div>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

function LogoCloud() {
  return (
    <section id="integrations" className="scroll-mt-20 py-20">
      <div className="mx-auto max-w-6xl px-6">
        <p className="text-center text-sm font-medium tracking-widest text-neutral-500 uppercase">
          Connects to the tools your team already uses
        </p>
        <h2 className="mx-auto mt-4 max-w-xl text-center text-3xl font-semibold tracking-tight text-balance">
          If it has an API, it can be an integration
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-neutral-400">
          First-class support for OAuth, bearer tokens, and API keys — plus anything describable
          by an OpenAPI document or an MCP server.
        </p>
        <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {INTEGRATIONS.map((integration) => (
            <div
              key={integration.slug}
              className="group flex items-center gap-3.5 rounded-2xl border border-white/5 bg-white/[0.03] p-4 transition hover:border-orange-500/30 hover:bg-white/[0.05]"
            >
              <BrandIcon slug={integration.slug} hex={integration.hex} name={integration.name} />
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold">{integration.name}</p>
                <p className="text-[13px] text-neutral-500">{integration.kind}</p>
              </div>
              <ArrowRight className="ml-auto size-4 shrink-0 text-neutral-600 transition group-hover:translate-x-0.5 group-hover:text-orange-400" />
            </div>
          ))}
          <div className="flex items-center gap-3.5 rounded-2xl border border-dashed border-orange-500/30 bg-orange-500/[0.04] p-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-orange-500/15 text-lg font-bold text-orange-300">
              +
            </span>
            <div>
              <p className="text-[15px] font-semibold">Your API here</p>
              <p className="text-[13px] text-neutral-500">Any OpenAPI · GraphQL · MCP server</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function HowItWorks() {
  return (
    <section id="how" className="scroll-mt-20 border-y border-white/5 bg-white/[0.015] py-20">
      <div className="mx-auto max-w-6xl px-6">
        <p className="text-center text-sm font-medium tracking-widest text-orange-400/90 uppercase">
          How it works
        </p>
        <h2 className="mx-auto mt-4 max-w-xl text-center text-3xl font-semibold tracking-tight text-balance">
          Install once. Then ask your agent.
        </h2>
        <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step) => (
            <div
              key={step.n}
              className="relative rounded-2xl border border-white/5 bg-neutral-950/60 p-6"
            >
              <div className="flex items-center justify-between">
                <span className="grid size-10 place-items-center rounded-xl bg-orange-500/10">
                  <step.icon className="size-5 text-orange-400" />
                </span>
                <span className="font-mono text-sm text-neutral-600">{step.n}</span>
              </div>
              <h3 className="mt-5 font-semibold">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-400">{step.body}</p>
            </div>
          ))}
        </div>
        <div className="mt-6 overflow-hidden rounded-2xl border border-white/5 bg-neutral-950/60 p-6 font-mono text-[13px] leading-relaxed">
          <p className="text-neutral-500">{"# one gateway, every harness"}</p>
          <p>
            <span className="text-orange-300">agent harness</span>
            <span className="text-neutral-500"> {"->"} </span>
            <span className="text-orange-300">sandbox</span>
            <span className="text-neutral-500"> {"->"} </span>
            <span className="text-emerald-300">client</span>
            <span className="text-neutral-500"> {"->"} </span>
            <span className="text-sky-300">gateway</span>
            <span className="text-neutral-500"> {"->"} </span>
            <span className="text-neutral-200">integration</span>
          </p>
          <p className="pl-[4.5rem] text-neutral-500">
            {"->"} <span className="text-violet-300">human</span> (approval when policy says so)
          </p>
        </div>
      </div>
    </section>
  )
}

function CodeShowcase() {
  const [tab, setTab] = useState<CodeTab>("cli")
  const snippet = CODE_SNIPPETS[tab]
  return (
    <section id="code" className="scroll-mt-20 py-20">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid items-start gap-10 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <p className="text-sm font-medium tracking-widest text-orange-400/90 uppercase">
              Built for agents
            </p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-balance">
              Three peers, one gateway API
            </h2>
            <p className="mt-4 leading-relaxed text-neutral-400">
              The <span className="font-mono text-[0.9em] text-neutral-200">i</span> CLI, the
              TypeScript client, and the MCP server are peers: each consumes the same versioned
              HTTP API, so no surface can drift from another.
            </p>
            <ul className="mt-6 space-y-3 text-sm">
              {[
                { icon: Search, text: "Search integrations and discover auth + schemas" },
                { icon: Braces, text: "Inspect schemas, validate inputs, execute tools" },
                { icon: Zap, text: "Poll approvals and resume paused executions" }
              ].map((item) => (
                <li key={item.text} className="flex items-center gap-3 text-neutral-300">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/5">
                    <item.icon className="size-4 text-orange-400" />
                  </span>
                  {item.text}
                </li>
              ))}
            </ul>
          </div>
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-neutral-950/90 shadow-2xl">
            <div className="flex items-center gap-1 border-b border-white/5 px-3 pt-3">
              {CODE_TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setTab(entry.id)}
                  className={`rounded-t-lg px-4 py-2.5 font-mono text-[13px] transition ${
                    tab === entry.id
                      ? "bg-white/10 text-white"
                      : "text-neutral-500 hover:text-neutral-300"
                  }`}
                >
                  {entry.label}
                </button>
              ))}
              <div className="ml-auto flex gap-1.5 pr-2 pb-2.5">
                <span className="size-2.5 rounded-full bg-neutral-700" />
                <span className="size-2.5 rounded-full bg-neutral-700" />
                <span className="size-2.5 rounded-full bg-orange-500/70" />
              </div>
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-neutral-200">
              {snippet}
            </pre>
          </div>
        </div>
      </div>
    </section>
  )
}

function Features() {
  return (
    <section id="features" className="scroll-mt-20 border-y border-white/5 bg-white/[0.015] py-20">
      <div className="mx-auto max-w-6xl px-6">
        <p className="text-center text-sm font-medium tracking-widest text-orange-400/90 uppercase">
          Why integrations
        </p>
        <h2 className="mx-auto mt-4 max-w-xl text-center text-3xl font-semibold tracking-tight text-balance">
          Stop pasting API keys into every agent
        </h2>
        <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="rounded-2xl border border-white/5 bg-neutral-950/60 p-6 transition hover:border-orange-500/25"
            >
              <span className="grid size-10 place-items-center rounded-xl bg-orange-500/10">
                <feature.icon className="size-5 text-orange-400" />
              </span>
              <h3 className="mt-5 font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-400">{feature.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function Security() {
  return (
    <section id="security" className="scroll-mt-20 py-20">
      <div className="mx-auto max-w-6xl px-6">
        <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-orange-500/[0.08] to-transparent p-10 sm:p-14">
          <div className="grid items-start gap-10 lg:grid-cols-2">
            <div>
              <p className="text-sm font-medium tracking-widest text-orange-400/90 uppercase">
                Security model
              </p>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-balance">
                Least privilege, enforced at execution
              </h2>
              <p className="mt-4 leading-relaxed text-neutral-400">
                Access and approval are independent layers. Which connections a client reaches is
                one decision; whether each tool runs immediately or waits for a human is another.
              </p>
            </div>
            <ul className="space-y-4">
              {[
                {
                  icon: Layers,
                  title: "Access profiles grant reach",
                  body: "Exactly one reusable profile per client scopes its connections and tools."
                },
                {
                  icon: Bell,
                  title: "Approval policies gate impact",
                  body: "Safe reads run; writes and unknowns pause with an execution id to resume."
                },
                {
                  icon: FileText,
                  title: "Every call is audited",
                  body: "Invocations, approvals, and denials land in one trail per gateway."
                }
              ].map((item) => (
                <li
                  key={item.title}
                  className="flex gap-4 rounded-2xl border border-white/5 bg-black/40 p-5"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-orange-500/10">
                    <item.icon className="size-5 text-orange-400" />
                  </span>
                  <div>
                    <p className="font-semibold">{item.title}</p>
                    <p className="mt-1 text-sm text-neutral-400">{item.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}

function GetStarted() {
  return (
    <section id="get-started" className="scroll-mt-20 pb-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="rounded-3xl border border-white/10 bg-neutral-950/80 p-8 sm:p-14">
          <h2 className="mx-auto max-w-xl text-3xl font-semibold tracking-tight text-balance">
            From zero to agent-powered integrations
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-neutral-400">
            The local gateway must be running for <span className="font-mono text-neutral-200">i</span> to work.
            After that, the skill gives your agent the full workflow.
          </p>
          <div className="mt-9 grid gap-3 text-left lg:grid-cols-3">
            {QUICKSTART.map((step) => (
              <div key={step.n} className="flex min-w-0 flex-col rounded-2xl border border-white/10 bg-black/60 p-5">
                <div className="flex items-center gap-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-orange-500 font-mono text-sm font-semibold text-black">
                    {step.n}
                  </span>
                  <h3 className="font-semibold">{step.title}</h3>
                </div>
                <div className="mt-4 flex min-h-24 items-start gap-2 rounded-xl border border-white/5 bg-white/[0.03] p-3">
                  <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-neutral-300">
                    {step.command}
                  </code>
                  <CopyButton text={step.command} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-6 text-center text-sm text-neutral-500">
            Want a visual control plane? Run <span className="font-mono text-neutral-300">ii dashboard</span> after installation.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3 text-center">
            <a
              href={`${REPO}/releases/latest`}
              className="flex items-center gap-2 rounded-xl bg-orange-500 px-6 py-3 font-semibold text-black transition hover:bg-orange-400"
            >
              Download latest release
              <ArrowRight className="size-4" />
            </a>
            <a
              href={REPO}
              className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-6 py-3 font-medium transition hover:bg-white/10"
            >
              <FileText className="size-4" />
              Read the docs
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="border-t border-white/5 py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-5 px-6 sm:flex-row">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg border border-orange-500/40 bg-orange-500/10">
            <Plug className="size-3.5 text-orange-400" />
          </span>
          <span className="text-sm font-semibold">integrations</span>
          <span className="text-sm text-neutral-600">· MIT licensed</span>
        </div>
        <nav className="flex items-center gap-6 text-sm text-neutral-400">
          <a href={REPO} className="transition hover:text-white">
            GitHub
          </a>
          <a href={`${REPO}/releases`} className="transition hover:text-white">
            Releases
          </a>
          <a href={`${REPO}/issues`} className="transition hover:text-white">
            Issues
          </a>
        </nav>
      </div>
    </footer>
  )
}

export default function App() {
  return (
    <div id="top" className="dark min-h-screen bg-black text-neutral-100">
      <Nav />
      <main>
        <Hero />
        <LogoCloud />
        <HowItWorks />
        <CodeShowcase />
        <Features />
        <Security />
        <GetStarted />
      </main>
      <Footer />
    </div>
  )
}
