import { lookup as systemLookup } from "node:dns"
import type { LookupAddress, LookupAllOptions } from "node:dns"
import { isIP } from "node:net"
import { whenPresent } from "@integragents/contracts"
import { DestinationRefused } from "./egress.ts"
import type { Connect } from "./egress.ts"
import { exemptHostname, permittedAddress } from "./url-policy.ts"
import type { UrlPolicy } from "./url-policy.ts"

export type AddressLookup = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: Array<LookupAddress>) => void
) => void

const resolveChecked = (hostname: string, policy: UrlPolicy, lookup: AddressLookup): Promise<string> =>
  new Promise((accept, reject) => {
    if (isIP(hostname) !== 0) {
      return exemptHostname(hostname, policy) || permittedAddress(hostname, policy)
        ? accept(hostname)
        : reject(new DestinationRefused(hostname))
    }
    lookup(hostname, { all: true }, (error, addresses) => {
      if (error !== null) return reject(error)
      const exempt = exemptHostname(hostname, policy)
      if (!exempt && !addresses.every((entry) => permittedAddress(entry.address, policy))) {
        return reject(new DestinationRefused(hostname))
      }
      const first = addresses[0]
      return first === undefined ? reject(new DestinationRefused(hostname)) : accept(first.address)
    })
  })

/**
 * Connects only to an address the policy allows: the name is resolved here,
 * every address it resolves to is checked, and the request is pinned to one
 * of them with the original Host header and TLS server name, so the runtime
 * never performs a second, unchecked lookup. Bun only: it needs `tls.serverName`.
 */
export const nativeConnect =
  (policy: UrlPolicy, lookup: AddressLookup = systemLookup): Connect =>
  async (url, init) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, "")
    const address = await resolveChecked(hostname, policy, lookup)
    const pinned = new URL(url)
    pinned.hostname = isIP(address) === 6 ? `[${address}]` : address
    const headers = new Headers(init.headers)
    headers.set("host", url.host)
    return globalThis.fetch(pinned, {
      ...init,
      headers,
      redirect: "manual",
      ...whenPresent("tls", url.protocol === "https:" ? { serverName: hostname } : undefined)
    })
  }
