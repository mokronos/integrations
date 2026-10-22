import { ArrowRight } from "lucide-react"
import { INTEGRATIONS } from "../content.ts"
import { BrandIcon } from "../components.tsx"

export function LogoCloud() {
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
          First-class support for OAuth, bearer tokens, and API keys — plus anything describable by an OpenAPI document
          or an MCP server.
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
