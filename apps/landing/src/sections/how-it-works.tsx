import { STEPS } from "../content.ts"

export function HowItWorks() {
  return (
    <section id="how" className="scroll-mt-20 border-y border-white/5 bg-white/[0.015] py-20">
      <div className="mx-auto max-w-6xl px-6">
        <p className="text-center text-sm font-medium tracking-widest text-orange-400/90 uppercase">How it works</p>
        <h2 className="mx-auto mt-4 max-w-xl text-center text-3xl font-semibold tracking-tight text-balance">
          Install once. Then ask your agent.
        </h2>
        <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step) => (
            <div key={step.n} className="relative rounded-2xl border border-white/5 bg-neutral-950/60 p-6">
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
