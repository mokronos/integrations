import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect } from "react"
import type { UseQueryResult } from "@tanstack/react-query"
import type {
  ApprovalStatus,
  GatewayResource,
  ProfileId
} from "@integragents/contracts"

import * as gateway from "@/lib/gateway"
import type { AuditQuery } from "@/lib/gateway"

export const keys = {
  me: ["me"] as const,
  authProviders: ["auth-providers"] as const,
  integrations: ["integrations"] as const,
  connections: ["connections"] as const,
  overview: ["overview"] as const,
  profiles: ["profiles"] as const,
  approvalDestinations: ["approval-destinations"] as const,
  profileApprovalDestinations: (id: ProfileId) => ["profiles", id, "approval-destinations"] as const,
  profileTools: (id: ProfileId) => ["profiles", id, "tools"] as const,
  approvalRules: (id: ProfileId) => ["profiles", id, "approval-rules"] as const,
  apiKeys: (id: ProfileId) => ["profiles", id, "keys"] as const,
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

export const useProfiles = () =>
  useQuery({
    queryKey: keys.profiles,
    queryFn: gateway.listProfiles,
    select: (response) => response.profiles
  })

export const useGatewayUrl = () =>
  useQuery({
    queryKey: keys.profiles,
    queryFn: gateway.listProfiles,
    select: (response) => response.gatewayUrl
  })

export const useMcpUrl = () =>
  useQuery({
    queryKey: keys.profiles,
    queryFn: gateway.listProfiles,
    select: (response) => response.mcpUrl
  })

export const useApprovalDestinations = () =>
  useQuery({ queryKey: keys.approvalDestinations, queryFn: gateway.listApprovalDestinations })

export const useProfileApprovalDestinations = (id: ProfileId) =>
  useQuery({
    queryKey: keys.profileApprovalDestinations(id),
    queryFn: () => gateway.getProfileApprovalDestinations(id)
  })


export const useOverview = () =>
  useQuery({ queryKey: keys.overview, queryFn: gateway.fetchOverview })

export const useApiKeys = (id: ProfileId) =>
  useQuery({ queryKey: keys.apiKeys(id), queryFn: () => gateway.listKeys(id) })

export const useProfileTools = (id: ProfileId) =>
  useQuery({ queryKey: keys.profileTools(id), queryFn: () => gateway.listProfileTools(id) })

export const useApprovalRules = (id: ProfileId) =>
  useQuery({ queryKey: keys.approvalRules(id), queryFn: () => gateway.listApprovalRules(id) })

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
  profiles: [keys.overview, keys.profiles, keys.oauthGrants],
  "approval-destinations": [keys.approvalDestinations, keys.profiles],
  integrations: [keys.overview, keys.integrations, keys.connections, ["oauth-session"], keys.profiles]
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
