import { lazy, useEffect, useState } from "react"
import { Navigate, Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { AuthGate } from "@/components/auth-gate"
import { Toaster } from "@/components/ui/sonner"

const AccountRoute = lazy(() => import("@/routes/account").then((route) => ({ default: route.AccountRoute })))
const ApprovalsRoute = lazy(() => import("@/routes/approvals").then((route) => ({ default: route.ApprovalsRoute })))
const ClientDetailRoute = lazy(() => import("@/routes/client-detail").then((route) => ({ default: route.ClientDetailRoute })))
const ClientsRoute = lazy(() => import("@/routes/clients").then((route) => ({ default: route.ClientsRoute })))
const ExecutionsRoute = lazy(() => import("@/routes/executions").then((route) => ({ default: route.ExecutionsRoute })))
const IntegrationsRoute = lazy(() => import("@/routes/integrations").then((route) => ({ default: route.IntegrationsRoute })))
const OverviewRoute = lazy(() => import("@/routes/overview").then((route) => ({ default: route.OverviewRoute })))
const AccessProfilesRoute = lazy(() => import("@/routes/policies").then((route) => ({ default: route.AccessProfilesRoute })))
const AccessProfileDetailRoute = lazy(() => import("@/routes/policies").then((route) => ({ default: route.AccessProfileDetailRoute })))
const ApprovalPoliciesRoute = lazy(() => import("@/routes/policies").then((route) => ({ default: route.ApprovalPoliciesRoute })))
const ApprovalPolicyDetailRoute = lazy(() => import("@/routes/policies").then((route) => ({ default: route.ApprovalPolicyDetailRoute })))

export default function App() {
  const [dark, setDark] = useState(() => localStorage.getItem("gateway-theme") !== "light")

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    document.documentElement.style.colorScheme = dark ? "dark" : "light"
    localStorage.setItem("gateway-theme", dark ? "dark" : "light")
  }, [dark])

  return (
    <>
      <AuthGate>
        <Routes>
          <Route element={<AppShell dark={dark} onDarkChange={setDark} />}>
            <Route index element={<OverviewRoute />} />
            <Route path="/integrations" element={<IntegrationsRoute />} />
            <Route path="/integrations/:slug" element={<IntegrationsRoute />} />
            <Route path="/clients" element={<ClientsRoute />} />
            <Route path="/clients/:clientId" element={<ClientDetailRoute />} />
            <Route path="/access-profiles" element={<AccessProfilesRoute />} />
            <Route path="/access-profiles/:accessProfileId" element={<AccessProfileDetailRoute />} />
            <Route path="/approval-policies" element={<ApprovalPoliciesRoute />} />
            <Route path="/approval-policies/:approvalPolicyId" element={<ApprovalPolicyDetailRoute />} />
            <Route path="/approvals" element={<ApprovalsRoute />} />
            <Route path="/activity" element={<ExecutionsRoute />} />
            <Route path="/executions" element={<Navigate to="/activity" replace />} />
            <Route path="/workbench" element={<Navigate to="/" replace />} />
            <Route path="/system" element={<Navigate to="/" replace />} />
            <Route path="/account" element={<AccountRoute />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthGate>
      <Toaster position="bottom-right" theme={dark ? "dark" : "light"} />
    </>
  )
}
