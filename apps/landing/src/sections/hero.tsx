import { ArrowRight, Globe, Lock, ShieldCheck, Terminal } from "lucide-react"
import { REPO, QUICKSTART } from "../content.ts"
import { GithubMark, CopyButton } from "../components.tsx"

export function Hero() {
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
          <span className="font-mono text-[0.9em] text-neutral-200"> i</span> CLI directly to discover, connect, and
          call external services under your policies.
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
            { icon: ShieldCheck, k: "Governed tools", v: "Off, Ask, or Allow per tool" }
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
