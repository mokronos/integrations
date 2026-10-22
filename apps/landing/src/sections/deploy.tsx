import { DEPLOYMENTS } from "../content.ts"
import { CopyButton } from "../components.tsx"

export function Deploy() {
  return (
    <section id="deploy" className="scroll-mt-20 py-20">
      <div className="mx-auto max-w-6xl px-6">
        <p className="text-center text-sm font-medium tracking-widest text-orange-400/90 uppercase">Run it your way</p>
        <h2 className="mx-auto mt-4 max-w-xl text-center text-3xl font-semibold tracking-tight text-balance">
          Your machine, your server, your process
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-neutral-400">
          The gateway holds your credentials, so it runs where you do. Start local; move to a server when more than one
          machine needs it.
        </p>
        <div className="mt-10 grid grid-cols-1 gap-3 lg:grid-cols-3">
          {DEPLOYMENTS.map((deployment) => (
            <div
              key={deployment.title}
              className={`flex min-w-0 flex-col rounded-2xl border p-6 ${
                deployment.tag === undefined
                  ? "border-white/5 bg-neutral-950/60"
                  : "border-orange-500/40 bg-orange-500/[0.05]"
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-xl bg-orange-500/10">
                  <deployment.icon className="size-5 text-orange-400" />
                </span>
                <h3 className="font-semibold">{deployment.title}</h3>
                {deployment.tag === undefined ? null : (
                  <span className="ml-auto rounded-full bg-orange-500 px-2.5 py-0.5 text-xs font-semibold text-black">
                    {deployment.tag}
                  </span>
                )}
              </div>
              <p className="mt-4 flex-1 text-sm leading-relaxed text-neutral-400">{deployment.body}</p>
              <div className="mt-5 flex items-center gap-2 rounded-xl border border-white/5 bg-black/60 p-3">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[12px] leading-relaxed text-neutral-300">
                  {deployment.command}
                </code>
                <CopyButton text={deployment.command} />
              </div>
            </div>
          ))}
        </div>
        <p className="mt-6 text-center text-sm text-neutral-500">
          Also runs on Cloudflare Workers as an experimental host.
        </p>
      </div>
    </section>
  )
}
