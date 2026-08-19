import { Navigate, Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { ApprovalsRoute } from "@/routes/approvals"
import { ClientDetailRoute } from "@/routes/client-detail"
import { ClientsRoute } from "@/routes/clients"
import { ExecutionsRoute } from "@/routes/executions"
import { IntegrationsRoute } from "@/routes/integrations"
import { SystemRoute } from "@/routes/system"

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/integrations" replace />} />
        <Route path="/integrations" element={<IntegrationsRoute />} />
        <Route path="/integrations/:slug" element={<IntegrationsRoute />} />
        <Route path="/clients" element={<ClientsRoute />} />
        <Route path="/clients/:clientId" element={<ClientDetailRoute />} />
        <Route path="/approvals" element={<ApprovalsRoute />} />
        <Route path="/executions" element={<ExecutionsRoute />} />
        <Route path="/system" element={<SystemRoute />} />
        <Route path="*" element={<Navigate to="/integrations" replace />} />
      </Route>
    </Routes>
  )
}
