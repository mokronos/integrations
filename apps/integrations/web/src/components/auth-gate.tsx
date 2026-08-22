import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { fetchMe, GatewayError, logIn, signUp, type Me } from "@/lib/gateway"

const SessionContext = createContext<Me | undefined>(undefined)

/** The authenticated identity the gate proved before rendering children.
 *  Undefined outside the gate (or while unauthenticated). */
export const useSession = (): Me | undefined => useContext(SessionContext)

/** The hosted gateway trusts no network locality, so the browser proves who it
 *  is the ordinary way: a session cookie from /v1/auth/login or the one-time
 *  signup that claims the instance. Everything below the gate assumes that
 *  cookie exists. */
export function AuthGate({ children }: { readonly children: ReactNode }) {
  const [me, setMe] = useState<Me | "checking">("checking")

  const refresh = useCallback(async () => {
    try {
      setMe(await fetchMe())
    } catch (error) {
      // A reachable-but-unhappy gateway still means "not signed in"; the form
      // is the honest screen either way.
      console.error("session check failed", error)
      setMe({ authenticated: false })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (me === "checking") {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <p className="text-muted-foreground text-sm">Connecting to the gateway…</p>
      </div>
    )
  }

  if (!me.authenticated) {
    return <AuthCard onAuthenticated={refresh} />
  }

  return (
    <SessionContext value={me}>
      {children}
    </SessionContext>
  )
}

function AuthCard({ onAuthenticated }: { readonly onAuthenticated: () => Promise<void> }) {
  const [tab, setTab] = useState<"signin" | "signup">("signin")

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Integrations control plane</CardTitle>
          <CardDescription>
            Sign in to manage connections, clients, and approvals. Agents use API
            keys minted here; humans sign in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={tab} onValueChange={(value) => setTab(value === "signup" ? "signup" : "signin")}>
            <TabsList className="w-full">
              <TabsTrigger value="signin" className="flex-1">Sign in</TabsTrigger>
              <TabsTrigger value="signup" className="flex-1">Create account</TabsTrigger>
            </TabsList>
            <TabsContent value="signin">
              <SignInForm onAuthenticated={onAuthenticated} />
            </TabsContent>
            <TabsContent value="signup">
              <SignUpForm
                onAuthenticated={onAuthenticated}
                onClosed={() => {
                  toast.error("Signup is closed on this gateway")
                  setTab("signin")
                }}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}

function SignInForm({ onAuthenticated }: { readonly onAuthenticated: () => Promise<void> }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      await logIn({ email, password })
      await onAuthenticated()
    } catch (error) {
      toast.error("Sign in failed", {
        description: error instanceof Error ? error.message : undefined
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-4 grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="signin-email">Email</Label>
        <Input
          id="signin-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="signin-password">Password</Label>
        <Input
          id="signin-password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  )
}

function SignUpForm({
  onAuthenticated,
  onClosed
}: {
  readonly onAuthenticated: () => Promise<void>
  readonly onClosed: () => void
}) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [tenantName, setTenantName] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      await signUp({ email, password, tenantName })
      await onAuthenticated()
    } catch (error) {
      if (error instanceof GatewayError && error.status === 403) {
        // Someone already claimed the instance; only sign-in remains.
        onClosed()
        return
      }
      toast.error("Could not create the account", {
        description: error instanceof Error ? error.message : undefined
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-4 grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="signup-email">Email</Label>
        <Input
          id="signup-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="signup-password">Password</Label>
        <Input
          id="signup-password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p className="text-muted-foreground text-xs">At least 8 characters.</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="signup-tenant">Workspace name</Label>
        <Input
          id="signup-tenant"
          type="text"
          placeholder="Defaults to your email name"
          value={tenantName}
          onChange={(event) => setTenantName(event.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          The first account claims this gateway — signup closes afterwards.
        </p>
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create account"}
      </Button>
    </form>
  )
}
