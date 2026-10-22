import { useState } from "react"
import { Braces, Search, Zap } from "lucide-react"
import { CODE_SNIPPETS, CODE_TABS } from "../content.ts"
import type { CodeTab } from "../content.ts"

export function CodeShowcase() {
  const [tab, setTab] = useState<CodeTab>("cli")
  const snippet = CODE_SNIPPETS[tab]
  return (
    <section id="code" className="scroll-mt-20 py-20">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid items-start gap-10 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <p className="text-sm font-medium tracking-widest text-orange-400/90 uppercase">Built for agents</p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-balance">Three peers, one gateway API</h2>
            <p className="mt-4 leading-relaxed text-neutral-400">
              The <span className="font-mono text-[0.9em] text-neutral-200">i</span> CLI, the TypeScript client, and the
              MCP server are peers: each consumes the same versioned HTTP API, so no surface can drift from another.
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
                    tab === entry.id ? "bg-white/10 text-white" : "text-neutral-500 hover:text-neutral-300"
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
            <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-neutral-200">{snippet}</pre>
          </div>
        </div>
      </div>
    </section>
  )
}
