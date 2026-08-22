/** Build-time stub. Wrangler's bundler resolves every static/dynamic import
 *  in the graph even when runtime gating means the code never executes: the
 *  MCP stdio transport is disabled by configuration and the SDK's DNS
 *  resolver sits behind a path nothing calls. Both specifiers are aliased
 *  here so neither ships.
 *
 *  Exports exist to satisfy the bundler; should anything ever reach them, the
 *  failure is loud and self-explanatory rather than silent. */
export class StdioClientTransport {
  constructor() {
    throw new Error("The stdio MCP transport is not available in this deployment")
  }
}

const dnsStub = new Proxy({}, {
  get: () => () => {
    throw new Error("node DNS resolution is not available in this deployment")
  }
})

export default dnsStub
export const resolve = dnsStub
