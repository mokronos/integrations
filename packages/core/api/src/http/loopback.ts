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

export const isLoopbackAddress = (address: string | undefined): boolean => {
  if (address === undefined || address.length === 0) return false
  const bare = address.startsWith("[") && address.endsWith("]")
    ? address.slice(1, -1)
    : address
  const unmapped = bare.startsWith("::ffff:") ? bare.slice("::ffff:".length) : bare
  if (unmapped === "::1" || unmapped === "0:0:0:0:0:0:0:1") return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(unmapped)
}

export const isLoopbackHostHeader = (host: string | null): boolean => {
  if (host === null || host.length === 0) return false
  const name = withoutPort(host.trim()).toLowerCase()
  return name === "localhost" || name === "[::1]" || name === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
}

export interface LoopbackBootstrap {
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

export const mayBorrowLocalCredential = (
  request: Request,
  bootstrap: LoopbackBootstrap
): boolean => {
  const headers = headersOf((name) => request.headers.get(name))
  return mayBorrow(headers, bootstrap)
}

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

  if (headers.secFetchSite?.trim().toLowerCase() !== "same-origin") {
    return false
  }

  const origin = headers.origin
  if (origin === null) return true
  return originsFor(bootstrap.port).includes(origin.trim().toLowerCase())
}
