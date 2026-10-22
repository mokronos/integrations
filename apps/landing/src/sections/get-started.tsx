import { ArrowRight, FileText } from "lucide-react"
import { REPO, QUICKSTART } from "../content.ts"
import { CopyButton } from "../components.tsx"

export function GetStarted() {
  return (
    <section id="get-started" className="scroll-mt-20 pb-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="rounded-3xl border border-white/10 bg-neutral-950/80 p-8 sm:p-14">
          <h2 className="mx-auto max-w-xl text-3xl font-semibold tracking-tight text-balance">
            From zero to agent-powered integrations
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-neutral-400">
            The local gateway must be running for <span className="font-mono text-neutral-200">i</span> to work. After
            that, the skill gives your agent the full workflow.
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
            Want a visual control plane? Run <span className="font-mono text-neutral-300">ii dashboard</span> after
            installation.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3 text-center">
            <a
              href={REPO}
              className="flex items-center gap-2 rounded-xl bg-orange-500 px-6 py-3 font-semibold text-black transition hover:bg-orange-400"
            >
              View on GitHub
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
