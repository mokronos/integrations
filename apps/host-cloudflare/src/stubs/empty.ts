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
