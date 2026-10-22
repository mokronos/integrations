import { Plug } from "lucide-react"
import { REPO } from "../content.ts"

export function Footer() {
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
