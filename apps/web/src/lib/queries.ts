import {
  useMutation,
  useQuery,
  useQueryClient
} from "@tanstack/react-query"
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query"

import * as gateway from "@/lib/gateway"
import type { ApprovalStatus } from "@/lib/schemas"
import type { AuditQuery } from "@/lib/gateway"

/** Query keys, in one place so an invalidation cannot miss a view.
 *
 * The gateway has no change feed, so every mutation states what it invalidates.
 * Getting that wrong shows up as a stale permission on screen, which is the one
 * kind of staleness this app must not have. */
export const keys = {
  integrations: ["integrations"] as const,
  integrationTools: (slug: string) => ["integrations", slug, "tools"] as const,
  connections: ["connections"] as const,
  overview: ["overview"] as const,
  clients: ["clients"] as const,
  approvalDestinations: ["approval-destinations"] as const,
  clientApprovalDestinations: (id: string) => ["clients", id, "approval-destinations"] as const,
  approvalDeliveries: (id: string) => ["approvals", id, "deliveries"] as const,
  accessProfiles: ["access-profiles"] as const,
  accessProfile: (id: string) => ["access-profiles", id] as const,
  approvalPolicies: ["approval-policies"] as const,
  approvalPolicy: (id: string) => ["approval-policies", id] as const,
  clientTools: (clientId: string) => ["clients", clientId, "tools"] as const,
  approvals: (status: ApprovalStatus | "all") => ["approvals", status] as const,
  audit: (input: AuditQuery) => ["audit", input] as const
}

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

export const useIntegrationTools = (slug: string | undefined) =>
  useQuery({
    queryKey: keys.integrationTools(slug ?? ""),
    queryFn: () => gateway.listIntegrationTools(slug ?? ""),
    enabled: slug !== undefined
  })

export const useConnections = () =>
  useQuery({ queryKey: keys.connections, queryFn: gateway.listConnections })

export const useClients = () =>
  useQuery({
    queryKey: keys.clients,
    queryFn: gateway.listClients,
    select: (response) => response.clients
  })
export const useApprovalDestinations = () => useQuery({ queryKey: keys.approvalDestinations, queryFn: gateway.listApprovalDestinations })
export const useClientApprovalDestinations = (id: string) => useQuery({
  queryKey: keys.clientApprovalDestinations(id), queryFn: () => gateway.getClientApprovalDestinations(id)
})
export const useApprovalDeliveries = (id: string) => useQuery({
  queryKey: keys.approvalDeliveries(id), queryFn: () => gateway.listApprovalDeliveries(id), refetchInterval: 5_000
})

/** The endpoint an MCP client connects to, as the gateway reports it. Shares
 *  the clients query because it is the same fact about the same list. */
export const useMcpUrl = () =>
  useQuery({
    queryKey: keys.clients,
    queryFn: gateway.listClients,
    select: (response) => response.mcpUrl
  })

export const useOverview = () =>
  useQuery({ queryKey: keys.overview, queryFn: gateway.fetchOverview, refetchInterval: 5_000 })

export const useAccessProfiles = () => useQuery({ queryKey: keys.accessProfiles, queryFn: gateway.listAccessProfiles })
export const useAccessProfile = (id: string | undefined) =>
  useQuery({
    queryKey: keys.accessProfile(id ?? ""), queryFn: () => gateway.getAccessProfile(id ?? ""), enabled: id !== undefined
  })
export const useApprovalPolicies = () => useQuery({ queryKey: keys.approvalPolicies, queryFn: gateway.listApprovalPolicies })
export const useApprovalPolicy = (id: string | undefined) =>
  useQuery({
    queryKey: keys.approvalPolicy(id ?? ""), queryFn: () => gateway.getApprovalPolicy(id ?? ""), enabled: id !== undefined
  })

export const useClientTools = (clientId: string | undefined) =>
  useQuery({
    queryKey: keys.clientTools(clientId ?? ""),
    queryFn: () => gateway.listClientTools(clientId ?? ""),
    enabled: clientId !== undefined
  })

/** Pending approvals are the one thing a human is actively waiting on, and they
 *  expire on a clock, so this view refreshes itself. */
export const useApprovals = (status: ApprovalStatus | "all") =>
  useQuery({
    queryKey: keys.approvals(status),
    queryFn: () => (status === "all" ? gateway.listApprovals() : gateway.listApprovals(status)),
    refetchInterval: status === "pending" ? 5_000 : false
  })

export const useAudit = (input: AuditQuery) =>
  useQuery({ queryKey: keys.audit(input), queryFn: () => gateway.listAudit(input) })

export type { UseMutationResult, UseQueryResult }

export const useInvalidate = () => {
  const client = useQueryClient()
  return (...groups: ReadonlyArray<ReadonlyArray<string>>) => {
    for (const group of groups) {
      void client.invalidateQueries({ queryKey: group })
    }
  }
}

export { useMutation, useQuery, useQueryClient }
