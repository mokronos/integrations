import { createContext, useContext, useState, type ReactNode } from "react"
import { LogIn } from "lucide-react"
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
import { GatewayError, logIn, signUp, type Me } from "@/lib/gateway"
import { useAuthProviders, useMe, useMutation } from "@/lib/queries"

const SessionContext = createContext<Me | undefined>(undefined)

export const useSession = (): Me | undefined => useContext(SessionContext)

export function AuthGate({ children }: { readonly children: ReactNode }) {
  const me = useMe()

  if (me.isPending) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <p className="text-muted-foreground text-sm">Connecting to the gateway…</p>
      </div>
    )
  }

  if (me.data === undefined && me.isError) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3">
        <p className="text-destructive text-sm">{me.error.message}</p>
        <Button variant="outline" size="sm" onClick={() => void me.refetch()} disabled={me.isFetching}>
          Retry
        </Button>
      </div>
    )
  }

  if (me.data?.authenticated !== true) {
    return <AuthCard onAuthenticated={() => me.refetch().then(() => undefined)} />
  }

  return (
    <SessionContext value={me.data}>
      {children}
    </SessionContext>
  )
}

type OnAuthenticated = () => Promise<void>

function AuthCard({ onAuthenticated }: { readonly onAuthenticated: OnAuthenticated }) {
  const [tab, setTab] = useState<"signin" | "signup">("signin")
  const providers = useAuthProviders().data

  const google = providers?.google
  const continueWithGoogle = () => {
    if (google?.enabled !== true) return
    const destination = new URL(google.startUrl, window.location.origin)
    destination.searchParams.set(
      "returnTo",
      `${window.location.pathname}${window.location.search}${window.location.hash}`
    )
    window.location.assign(destination)
  }

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
          {google?.enabled === true
            ? (
              <>
                <Button type="button" variant="outline" className="w-full" onClick={continueWithGoogle}>
                  <LogIn className="size-4" /> Continue with Google
                </Button>
                <div className="text-muted-foreground my-4 flex items-center gap-3 text-xs">
                  <span className="h-px flex-1 bg-border" /> or use a password
                  <span className="h-px flex-1 bg-border" />
                </div>
              </>
            )
            : null}
          {providers?.signupOpen === true
            ? (
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
            )
            : <SignInForm onAuthenticated={onAuthenticated} />}
        </CardContent>
      </Card>
    </div>
  )
}

function SignInForm({ onAuthenticated }: { readonly onAuthenticated: OnAuthenticated }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const signIn = useMutation({
    mutationFn: () => logIn({ email, password }),
    onSuccess: onAuthenticated,
    onError: (error: Error) => toast.error("Sign in failed", { description: error.message })
  })

  return (
    <form onSubmit={(event) => { event.preventDefault(); signIn.mutate() }} className="mt-4 grid gap-4">
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
      <Button type="submit" disabled={signIn.isPending}>
        {signIn.isPending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  )
}

function SignUpForm({
  onAuthenticated,
  onClosed
}: {
  readonly onAuthenticated: OnAuthenticated
  readonly onClosed: () => void
}) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [tenantName, setTenantName] = useState("")
  const create = useMutation({
    mutationFn: () => signUp({ email, password, tenantName }),
    onSuccess: onAuthenticated,
    onError: (error: Error) => error instanceof GatewayError && error.code === "signup-closed"
      ? onClosed()
      : toast.error("Could not create the account", { description: error.message })
  })

  return (
    <form onSubmit={(event) => { event.preventDefault(); create.mutate() }} className="mt-4 grid gap-4">
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
      <Button type="submit" disabled={create.isPending}>
        {create.isPending ? "Creating…" : "Create account"}
      </Button>
    </form>
  )
}
