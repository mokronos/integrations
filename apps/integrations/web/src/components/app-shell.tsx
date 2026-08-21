import { useState } from "react"
import { NavLink, Outlet } from "react-router"
import {
  Activity,
  Braces,
  KeyRound,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  ShieldCheck,
  Sun,
  Wrench
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useApprovals } from "@/lib/queries"
import { cn } from "@/lib/utils"

const navigation = [
  { to: "/integrations", label: "Integrations", icon: Plug },
  { to: "/clients", label: "Clients", icon: KeyRound },
  { to: "/approvals", label: "Approvals", icon: ShieldCheck },
  { to: "/executions", label: "Executions", icon: Activity },
  { to: "/workbench", label: "Workbench", icon: Braces },
  { to: "/system", label: "System", icon: Wrench }
] as const

/** The count is the point of the badge: a frozen invocation is a person waiting,
 *  and it expires whether or not anyone looked. */
function PendingBadge({ compact }: { readonly compact: boolean }) {
  const approvals = useApprovals("pending")
  const count = approvals.data?.length ?? 0
  if (count === 0) return null
  return (
    <Badge
      variant="destructive"
      className={compact ? "absolute -right-1 -top-1 h-4 min-w-4 px-1 text-[0.625rem]" : "ml-auto"}
    >
      {count}
    </Badge>
  )
}

export function AppShell({
  dark,
  onDarkChange
}: {
  readonly dark: boolean
  readonly onDarkChange: (dark: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="bg-background flex h-svh overflow-hidden">
      <aside
        className={cn(
          "bg-sidebar text-sidebar-foreground flex min-h-0 shrink-0 flex-col gap-1 overflow-y-auto border-r p-2 transition-[width]",
          expanded ? "w-60" : "w-16"
        )}
      >
        <div className={cn("flex h-14 items-center", expanded ? "justify-between px-2" : "justify-center")}>
          {expanded ? (
            <div className="min-w-0">
              <p className="truncate text-xs uppercase tracking-widest opacity-60">gateway</p>
              <p className="truncate font-semibold">Control plane</p>
            </div>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={expanded ? "Collapse navigation" : "Expand navigation"}
            title={expanded ? "Collapse navigation" : "Expand navigation"}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <PanelLeftClose /> : <PanelLeftOpen />}
          </Button>
        </div>
        <nav className="flex flex-col gap-0.5">
          {navigation.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              aria-label={expanded ? undefined : item.label}
              title={expanded ? undefined : item.label}
              className={({ isActive }) =>
                cn(
                  "relative flex h-9 items-center rounded-md text-sm transition-colors",
                  expanded ? "gap-2 px-2" : "justify-center px-0",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "hover:bg-sidebar-accent/50"
                )}
            >
              <item.icon className="size-4" />
              {expanded ? item.label : null}
              {item.to === "/approvals" ? <PendingBadge compact={!expanded} /> : null}
            </NavLink>
          ))}
        </nav>
        <div className={cn("mt-auto space-y-3", expanded ? "px-2" : "flex justify-center")}>
          {expanded
            ? (
              <>
                <label htmlFor="appearance" className="flex cursor-pointer items-center gap-2 text-sm">
                  {dark ? <Moon className="size-4" /> : <Sun className="size-4" />}
                  <span>Dark mode</span>
                  <Switch
                    id="appearance"
                    className="ml-auto"
                    checked={dark}
                    onCheckedChange={onDarkChange}
                  />
                </label>
                <p className="text-sidebar-foreground/50 text-xs leading-relaxed">
                  Served by the gateway on loopback. Every action here is performed with
                  the local client's key.
                </p>
              </>
            )
            : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={dark ? "Use light mode" : "Use dark mode"}
                title={dark ? "Use light mode" : "Use dark mode"}
                onClick={() => onDarkChange(!dark)}
              >
                {dark ? <Moon /> : <Sun />}
              </Button>
            )}
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}
