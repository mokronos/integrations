import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect } from "react"
import type { UseQueryResult } from "@tanstack/react-query"
import type {
  AccessProfileId,
  ApprovalPolicyId,
  ApprovalStatus,
  ClientId,
  GatewayResource
} from "@integragents/contracts"

import * as gateway from "@/lib/gateway"
import type { AuditQuery } from "@/lib/gateway"

export const keys = {
  me: ["me"] as const,
  authProviders: ["auth-providers"] as const,
  integrations: ["integrations"] as const,
  connections: ["connections"] as const,
  overview: ["overview"] as const,
  clients: ["clients"] as const,
  approvalDestinations: ["approval-destinations"] as const,
  clientApprovalDestinations: (id: ClientId) => ["clients", id, "approval-destinations"] as const,
  accessProfiles: ["access-profiles"] as const,
  accessProfile: (id: AccessProfileId | undefined) => ["access-profiles", id] as const,
  approvalPolicies: ["approval-policies"] as const,
  approvalPolicy: (id: ApprovalPolicyId | undefined) => ["approval-policies", id] as const,
  clientTools: (id: ClientId | undefined) => ["clients", id, "tools"] as const,
  apiKeys: (id: ClientId) => ["clients", id, "keys"] as const,
  approvals: (status: ApprovalStatus | "all") => ["approvals", status] as const,
  audit: (input: AuditQuery) => ["audit", input] as const,
  oauthSession: (id: string | undefined) => ["oauth-session", id] as const,
  oauthGrants: ["oauth-grants"] as const
}

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: gateway.fetchMe })

export const useAuthProviders = () =>
  useQuery({ queryKey: keys.authProviders, queryFn: gateway.fetchAuthProviders })

export const useIntegrations = () =>
  useQuery({
    queryKey: keys.integrations,
    queryFn: gateway.listIntegrations,
    select: (response) => response.integrations
  })

export const useOAuthCallbackUrl = () =>
  useQuery({
    queryKey: keys.integrations,
    queryFn: gateway.listIntegrations,
    select: (response) => response.oauthCallbackUrl
  })

export const useConnections = () =>
  useQuery({ queryKey: keys.connections, queryFn: gateway.listConnections })

export const useClients = () =>
  useQuery({
    queryKey: keys.clients,
    queryFn: gateway.listClients,
    select: (response) => response.clients
  })

export const useGatewayUrl = () =>
  useQuery({
    queryKey: keys.clients,
    queryFn: gateway.listClients,
    select: (response) => response.gatewayUrl
  })

export const useMcpUrl = () =>
  useQuery({
    queryKey: keys.clients,
    queryFn: gateway.listClients,
    select: (response) => response.mcpUrl
  })

export const useApprovalDestinations = () =>
  useQuery({ queryKey: keys.approvalDestinations, queryFn: gateway.listApprovalDestinations })

export const useClientApprovalDestinations = (id: ClientId) =>
  useQuery({
    queryKey: keys.clientApprovalDestinations(id),
    queryFn: () => gateway.getClientApprovalDestinations(id)
  })


export const useOverview = () =>
  useQuery({ queryKey: keys.overview, queryFn: gateway.fetchOverview })

export const useAccessProfiles = () =>
  useQuery({ queryKey: keys.accessProfiles, queryFn: gateway.listAccessProfiles })

export const useAccessProfile = (id: AccessProfileId | undefined) =>
  useQuery({
    queryKey: keys.accessProfile(id),
    queryFn: id === undefined ? skipToken : () => gateway.getAccessProfile(id)
  })

export const useApprovalPolicies = () =>
  useQuery({ queryKey: keys.approvalPolicies, queryFn: gateway.listApprovalPolicies })

export const useApprovalPolicy = (id: ApprovalPolicyId | undefined) =>
  useQuery({
    queryKey: keys.approvalPolicy(id),
    queryFn: id === undefined ? skipToken : () => gateway.getApprovalPolicy(id)
  })

export const useApiKeys = (id: ClientId) =>
  useQuery({ queryKey: keys.apiKeys(id), queryFn: () => gateway.listKeys(id) })

export const useClientTools = (id: ClientId | undefined) =>
  useQuery({
    queryKey: keys.clientTools(id),
    queryFn: id === undefined ? skipToken : () => gateway.listClientTools(id)
  })

export const useApprovals = (status: ApprovalStatus | "all") =>
  useQuery({
    queryKey: keys.approvals(status),
    queryFn: () => gateway.listApprovals(status === "all" ? undefined : status)
  })

export const useAudit = (input: AuditQuery) =>
  useQuery({ queryKey: keys.audit(input), queryFn: () => gateway.listAudit(input) })

export const useOAuthGrants = () =>
  useQuery({ queryKey: keys.oauthGrants, queryFn: gateway.listOAuthGrants })

export const useOAuthSession = (id: string | undefined) =>
  useQuery({
    queryKey: keys.oauthSession(id),
    queryFn: id === undefined ? skipToken : () => gateway.getOAuthSession(id)
  })

const reloadedBy = {
  approvals: [keys.overview, ["approvals"]],
  audit: [keys.overview, ["audit"], ["onboarding-activity"]],
  clients: [keys.overview, keys.clients],
  policies: [keys.overview, keys.accessProfiles, keys.approvalPolicies, keys.clients],
  "approval-destinations": [keys.approvalDestinations, keys.clients],
  integrations: [keys.overview, keys.integrations, keys.connections, ["oauth-session"], keys.clients]
} satisfies Record<GatewayResource, ReadonlyArray<ReadonlyArray<string>>>

/** Reloads what the gateway reports changed; a fresh connection reloads everything it may have missed. */
export const useGatewayEvents = () => {
  const client = useQueryClient()
  useEffect(() => gateway.followEvents((event) => {
    if (event._tag === "Connected") void client.invalidateQueries()
    if (event._tag === "Changed") {
      for (const queryKey of reloadedBy[event.resource]) void client.invalidateQueries({ queryKey })
    }
  }), [client])
}

export const useInvalidate = () => {
  const client = useQueryClient()
  return useCallback((...groups: ReadonlyArray<ReadonlyArray<string | undefined>>) => {
    for (const group of groups) {
      void client.invalidateQueries({ queryKey: group })
    }
  }, [client])
}

export { useMutation, useQuery }

export const refetchAll = (...queries: ReadonlyArray<Pick<UseQueryResult, "refetch">>): Promise<void> =>
  Promise.all(queries.map((query) => query.refetch())).then(() => undefined)
