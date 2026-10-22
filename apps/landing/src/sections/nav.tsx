import { ArrowRight, Plug } from "lucide-react"
import { REPO } from "../content.ts"
import { GithubMark } from "../components.tsx"

export function Nav() {
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
          <a href="#deploy" className="transition hover:text-white">
            Deploy
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
