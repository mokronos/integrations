import { homedir } from "node:os"
import path from "node:path"

/** Where credentials, the Executor catalog, and the gateway's own store live.
 *
 * `WF_HOME` is still honoured because the directory has not moved on disk —
 * the gateway took ownership of resolving it, not of relocating it. */
export const integrationsHome = (
  environment: NodeJS.ProcessEnv = process.env
): string => {
  const configured = environment["INTEGRATIONS_HOME"] ?? environment["WF_HOME"]
  return configured === undefined || configured.length === 0
    ? path.join(homedir(), ".wf")
    : path.resolve(configured)
}

/** Clients, API keys, grants, approvals, and audit records. Separate from
 * Executor's database because resolving a grant is what determines the subject
 * an Executor instance must be bound to — so it has to be readable first. */
export const gatewayDatabasePath = (home: string): string =>
  path.join(home, "gateway.sqlite")
