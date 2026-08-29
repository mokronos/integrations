import { createHostHandle, createIntegrationsApi } from "@mokronos/integrations"
import type { HostHandle, IntegrationsApi } from "@mokronos/integrations"
import { integrationsHome } from "@mokronos/integrations-client"

export interface Gateway {
  readonly directory: string
  readonly host: HostHandle
  readonly integrations: IntegrationsApi
  close(): Promise<void>
}

/** Composes one gateway over an explicit storage directory. Construction of the
 * underlying host stays lazy, and nothing mutates global storage state. */
export const createGateway = (
  options: { readonly directory?: string } = {}
): Gateway => {
  const host = createHostHandle(options.directory ?? integrationsHome())
  return {
    directory: host.directory,
    host,
    integrations: createIntegrationsApi(host),
    close: () => host.close()
  }
}
