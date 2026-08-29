import type { IntegrationsApi } from "@mokronos/integrations"

/** Members a given test never reaches. Throwing is deliberate: a partial fake
 *  that returned `undefined` would let a handler quietly start depending on one
 *  of these and still pass. */
export const notStubbed = (member: string) => () => {
  throw new Error(`stubIntegrations: ${member} is not stubbed for these tests`)
}

/** A host that answers nothing. For tests about the gateway's own behaviour —
 *  authority, sessions, failure handling — where the host is only present
 *  because the handler seam requires one. */
export const stubIntegrations = (): IntegrationsApi => ({
  tools: {
    execute: notStubbed("tools.execute"),
    summaries: async () => [],
    describe: notStubbed("tools.describe"),
    list: async () => []
  },
  connections: {
    list: async () => [],
    remove: notStubbed("connections.remove"),
    create: notStubbed("connections.create"),
    ensure: notStubbed("connections.ensure")
  },
  catalog: {
    classify: notStubbed("catalog.classify"),
    list: notStubbed("catalog.list"),
    find: notStubbed("catalog.find"),
    addMcp: notStubbed("catalog.addMcp"),
    addOpenApi: notStubbed("catalog.addOpenApi")
  },
  auth: {
    probe: notStubbed("auth.probe"),
    registerClient: notStubbed("auth.registerClient"),
    createClient: notStubbed("auth.createClient"),
    start: notStubbed("auth.start"),
    complete: notStubbed("auth.complete")
  },
  provisioning: {
    install: notStubbed("provisioning.install"),
    provision: notStubbed("provisioning.provision")
  },
  validateIntegrationNode: notStubbed("validateIntegrationNode"),
  listIntegrationOverviews: async () => []
})
