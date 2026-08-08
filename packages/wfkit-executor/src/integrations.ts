/** Compatibility barrel for integration-facing APIs. Discovery, connection
 * policy, projections, and validation are implemented independently. */
export {
  discoverIntegration,
  inspectIntegration,
  installIntegration
} from "./discovery.ts"
export {
  IntegrationDiscovery,
  IntegrationInspection,
  IntegrationKind,
  IntegrationNodeConfig,
  IntegrationValidationFinding,
  IntegrationValidationReport
} from "./integration-model.ts"
export type { DiscoverIntegrationsOptions } from "./integration-model.ts"
export { listIntegrationOverviews } from "./overview.ts"
export { validateIntegrationNode } from "./validation.ts"
