import { FEATURES } from "../content.ts"

export function Features() {
  return (
    <section id="features" className="scroll-mt-20 border-y border-white/5 bg-white/[0.015] py-20">
      <div className="mx-auto max-w-6xl px-6">
        <p className="text-center text-sm font-medium tracking-widest text-orange-400/90 uppercase">Why integrations</p>
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
