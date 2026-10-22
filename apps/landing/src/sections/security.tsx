import { Bell, FileText, Layers } from "lucide-react"

export function Security() {
  return (
    <section id="security" className="scroll-mt-20 py-20">
      <div className="mx-auto max-w-6xl px-6">
        <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-orange-500/[0.08] to-transparent p-10 sm:p-14">
          <div className="grid items-start gap-10 lg:grid-cols-2">
            <div>
              <p className="text-sm font-medium tracking-widest text-orange-400/90 uppercase">Security model</p>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-balance">
                Least privilege, enforced at execution
              </h2>
              <p className="mt-4 leading-relaxed text-neutral-400">
                A profile turns each tool off, or on with Ask or Allow. Changing one agent's profile never changes
                another's, and every call names the app that made it.
              </p>
            </div>
            <ul className="space-y-4">
              {[
                {
                  icon: Layers,
                  title: "Profiles grant reach",
                  body: "Only the tools a profile turns on are visible or callable."
                },
                {
                  icon: Bell,
                  title: "Ask gates impact",
                  body: "Safe reads run; writes and unknowns pause with an execution id to resume."
                },
                {
                  icon: FileText,
                  title: "Every call is audited",
                  body: "Invocations, approvals, and denials land in one trail per gateway."
                }
              ].map((item) => (
                <li key={item.title} className="flex gap-4 rounded-2xl border border-white/5 bg-black/40 p-5">
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
