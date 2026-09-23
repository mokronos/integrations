import type { AccessProfileId, ApprovalPolicyId } from "@integragents/contracts"

import * as gateway from "@/lib/gateway"
import { keys } from "@/lib/queries"

export type ConfigurationResource<Id extends string> = {
  readonly id: Id
  readonly name: string
  readonly isDefault: boolean
  readonly updatedAt: Date
}

export interface ConfigurationKind<Id extends string> {
  readonly label: string
  readonly path: string
  readonly queryKeys: (id: Id) => ReadonlyArray<ReadonlyArray<string | undefined>>
  readonly create: (name: string) => Promise<ConfigurationResource<Id>>
  readonly clone: (id: Id, name: string) => Promise<ConfigurationResource<Id>>
  readonly rename: (id: Id, name: string) => Promise<ConfigurationResource<Id>>
  readonly remove: (id: Id) => Promise<void>
}

export const accessProfileKind: ConfigurationKind<AccessProfileId> = {
  label: "access profile",
  path: "/access-profiles",
  queryKeys: (id) => [keys.accessProfiles, keys.accessProfile(id)],
  create: gateway.createAccessProfile,
  clone: (id, name) => gateway.cloneAccessProfile(id, name).then((cloned) => cloned.accessProfile),
  rename: gateway.renameAccessProfile,
  remove: (id) => gateway.deleteAccessProfile(id).then(() => undefined)
}

export const approvalPolicyKind: ConfigurationKind<ApprovalPolicyId> = {
  label: "approval policy",
  path: "/approval-policies",
  queryKeys: (id) => [keys.approvalPolicies, keys.approvalPolicy(id)],
  create: gateway.createApprovalPolicy,
  clone: (id, name) => gateway.cloneApprovalPolicy(id, name).then((cloned) => cloned.approvalPolicy),
  rename: gateway.renameApprovalPolicy,
  remove: (id) => gateway.deleteApprovalPolicy(id).then(() => undefined)
}
