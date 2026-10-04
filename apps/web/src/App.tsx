import { lazy, useEffect, useState } from "react"
import { Navigate, Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { AuthGate } from "@/components/auth-gate"
import { Toaster } from "@/components/ui/sonner"

const ActivityRoute = lazy(() => import("@/routes/activity").then((route) => ({ default: route.ActivityRoute })))
const ApprovalsRoute = lazy(() => import("@/routes/approvals").then((route) => ({ default: route.ApprovalsRoute })))
const HomeRoute = lazy(() => import("@/routes/home").then((route) => ({ default: route.HomeRoute })))
const IntegrationsRoute = lazy(() => import("@/routes/integrations").then((route) => ({ default: route.IntegrationsRoute })))
const OnboardingRoute = lazy(() => import("@/routes/onboarding").then((route) => ({ default: route.OnboardingRoute })))
const ProfilesRoute = lazy(() => import("@/routes/profiles").then((route) => ({ default: route.ProfilesRoute })))
const ProfileDetailRoute = lazy(() => import("@/routes/profiles").then((route) => ({ default: route.ProfileDetailRoute })))
const SettingsRoute = lazy(() => import("@/routes/settings").then((route) => ({ default: route.SettingsRoute })))
const OAuthConsentRoute = lazy(() => import("@/routes/oauth-consent").then((route) => ({ default: route.OAuthConsentRoute })))

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
          <Route path="/oauth/consent" element={<OAuthConsentRoute />} />
          <Route element={<AppShell dark={dark} onDarkChange={setDark} />}>
            <Route index element={<HomeRoute />} />
            <Route path="/onboarding" element={<OnboardingRoute />} />
            <Route path="/approvals" element={<ApprovalsRoute />} />
            <Route path="/integrations" element={<IntegrationsRoute />} />
            <Route path="/integrations/:slug" element={<IntegrationsRoute />} />
            <Route path="/profiles" element={<ProfilesRoute />} />
            <Route path="/profiles/:profileId" element={<ProfileDetailRoute />} />
            <Route path="/activity" element={<ActivityRoute />} />
            <Route path="/settings" element={<SettingsRoute />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthGate>
      <Toaster position="bottom-right" theme={dark ? "dark" : "light"} />
    </>
  )
}
