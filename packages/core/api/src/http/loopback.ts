/** Ambient authority for the control plane, and nothing else.
 *
 * Every other client authenticates with a key it was handed. A browser cannot
 * be: the local key lives in a `0600` file that a page has no way to read, and
 * asking a human to paste a credential that unlocks every connection into a web
 * form teaches exactly the wrong habit. So a request that is unmistakably the
 * control plane's own page, talking to its own origin, over loopback, borrows
 * the local client's key instead of carrying one.
 *
 * What this is and is not:
 *
 *  - It **is** a defence against the realistic attack, which is a page on some
 *    other site reaching for `127.0.0.1:4788` while you have it open. `Origin`,
 *    `Sec-Fetch-Site` and `Host` together stop that, and a browser will not let
 *    a page forge any of the three.
 *
 *  - It is **not** a boundary against other processes on the machine. Anything
 *    that can open a socket to loopback can also send these headers. Binding the
 *    gateway to loopback already trusts local processes; this does not widen
 *    that, but it does not narrow it either. A gateway bound off loopback turns
 *    the whole mechanism off, because a proxy on the same box would make every
 *    forwarded request look local.
 *
 * Requests with no `Sec-Fetch-Site` at all — curl, the CLI, any API client —
 * get no ambient authority and must present a key as before. The browser is the
 * exception here, not the new rule.
 */

/** The gateway's own origins, as a browser would write them. */
const originsFor = (port: number): ReadonlyArray<string> => [
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  `http://[::1]:${port}`
]

const withoutPort = (host: string): string => {
  if (host.startsWith("[")) {
    const close = host.indexOf("]")
    return close === -1 ? host : host.slice(0, close + 1)
  }
  const colon = host.lastIndexOf(":")
  return colon === -1 ? host : host.slice(0, colon)
}

/** IPv4 loopback is a whole `/8`, and an IPv6 socket reports IPv4 peers in the
 *  `::ffff:` mapped form. */
export const isLoopbackAddress = (address: string | undefined): boolean => {
  if (address === undefined || address.length === 0) return false
  const bare = address.startsWith("[") && address.endsWith("]")
    ? address.slice(1, -1)
    : address
  const unmapped = bare.startsWith("::ffff:") ? bare.slice("::ffff:".length) : bare
  if (unmapped === "::1" || unmapped === "0:0:0:0:0:0:0:1") return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(unmapped)
}

/** Guards DNS rebinding: an attacker's domain resolving to 127.0.0.1 still
 *  arrives carrying its own name in `Host`, and is refused here. */
export const isLoopbackHostHeader = (host: string | null): boolean => {
  if (host === null || host.length === 0) return false
  const name = withoutPort(host.trim()).toLowerCase()
  return name === "localhost" || name === "[::1]" || name === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
}

export interface LoopbackBootstrap {
  /** False whenever `--host` moved the socket off loopback. */
  readonly boundToLoopback: boolean
  readonly port: number
  readonly remoteAddress: string | undefined
}

interface BorrowHeaders {
  readonly host: string | null
  readonly origin: string | null
  readonly secFetchSite: string | null
}

const headersOf = (get: (name: string) => string | null): BorrowHeaders => ({
  host: get("host"),
  origin: get("origin"),
  secFetchSite: get("sec-fetch-site")
})

/** Whether this request may be authenticated as the local client. */
export const mayBorrowLocalCredential = (
  request: Request,
  bootstrap: LoopbackBootstrap
): boolean => {
  const headers = headersOf((name) => request.headers.get(name))
  return mayBorrow(headers, bootstrap)
}

/** The same decision for a server that reads headers out of the platform
 *  request rather than a web `Request`. */
export const mayBorrowLocalCredentialHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  bootstrap: LoopbackBootstrap
): boolean =>
  mayBorrow({
    host: headers["host"] ?? null,
    origin: headers["origin"] ?? null,
    secFetchSite: headers["sec-fetch-site"] ?? null
  }, bootstrap)

const mayBorrow = (
  headers: ReturnType<typeof headersOf>,
  bootstrap: LoopbackBootstrap
): boolean => {
  if (!bootstrap.boundToLoopback) return false
  if (!isLoopbackAddress(bootstrap.remoteAddress)) return false
  if (!isLoopbackHostHeader(headers.host)) return false

  // Set by the browser on every request it makes, and unforgeable from script.
  // Its absence means the caller is not a page, and non-pages bring their own
  // key — this path exists only because a page cannot.
  if (headers.secFetchSite?.trim().toLowerCase() !== "same-origin") {
    return false
  }

  // Same-origin GETs carry no Origin at all; same-origin writes carry ours.
  const origin = headers.origin
  if (origin === null) return true
  return originsFor(bootstrap.port).includes(origin.trim().toLowerCase())
}
