import { lookup as systemLookup } from "node:dns"
import type { LookupAddress, LookupAllOptions } from "node:dns"
import { Agent as HttpAgent, request as httpRequest } from "node:http"
import type { IncomingMessage } from "node:http"
import { Agent as HttpsAgent, request as httpsRequest } from "node:https"
import { isIP } from "node:net"
import type { LookupFunction } from "node:net"
import type { Readable } from "node:stream"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"
import { DestinationRefused } from "./egress.ts"
import type { Connect } from "./egress.ts"
import { exemptHostname, permittedAddress } from "./url-policy.ts"
import type { UrlPolicy } from "./url-policy.ts"

export type AddressLookup = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: Array<LookupAddress>) => void
) => void

/**
 * The resolver every connection of a connector goes through: it resolves the
 * name, refuses it unless every address it resolves to is allowed, and hands
 * the runtime those addresses only, so nothing connects after a second,
 * unchecked lookup.
 */
const checkedLookup =
  (policy: UrlPolicy, lookup: AddressLookup): LookupFunction =>
  (hostname, options, callback) =>
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error !== null) return callback(error, "")
      const allowed =
        exemptHostname(hostname, policy) || addresses.every((entry) => permittedAddress(entry.address, policy))
      const first = addresses[0]
      if (!allowed || first === undefined) return callback(new DestinationRefused(hostname), "")
      return options.all === true ? callback(null, addresses) : callback(null, first.address, first.family)
    })

/** Statuses whose responses never carry a body. */
const bodilessStatuses = new Set([101, 103, 204, 205, 304])

/** `fetch` decodes these; a plain HTTP request does not, so the connector does. */
const decoders = {
  gzip: createGunzip,
  "x-gzip": createGunzip,
  deflate: createInflate,
  br: createBrotliDecompress
}

const isDecodable = (encoding: string): encoding is keyof typeof decoders => encoding in decoders

/** A web stream over a Node one, read only as fast as the consumer pulls. */
const webStream = (source: Readable): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      source.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk))
        if ((controller.desiredSize ?? 0) <= 0) source.pause()
      })
      source.on("end", () => controller.close())
      source.on("error", (error) => controller.error(error))
    },
    pull: () => {
      source.resume()
    },
    cancel: () => {
      source.destroy()
    }
  })

const toResponse = (incoming: IncomingMessage, method: string): Response => {
  const headers = new Headers()
  for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
    const [name, value] = [incoming.rawHeaders[index], incoming.rawHeaders[index + 1]]
    if (name !== undefined && value !== undefined) headers.append(name, value)
  }
  const status = incoming.statusCode ?? 502
  const init = { status, statusText: incoming.statusMessage ?? "", headers }
  if (method === "HEAD" || bodilessStatuses.has(status)) {
    incoming.resume()
    return new Response(null, init)
  }
  const encoding = headers.get("content-encoding")?.trim().toLowerCase() ?? ""
  if (!isDecodable(encoding)) return new Response(webStream(incoming), init)
  headers.delete("content-encoding")
  headers.delete("content-length")
  return new Response(webStream(incoming.pipe(decoders[encoding]())), init)
}

/**
 * Connects only to an address the policy allows: the name is resolved through
 * a checked lookup, so the URL keeps its hostname, and with it the Host
 * header, the TLS server name and the certificate check, on Node and Bun
 * alike. Request bodies are buffered so every request carries a length.
 */
export const nativeConnect = (policy: UrlPolicy, lookup: AddressLookup = systemLookup): Connect => {
  const resolve = checkedLookup(policy, lookup)
  const agents = {
    http: new HttpAgent({ keepAlive: true, lookup: resolve }),
    https: new HttpsAgent({ keepAlive: true, lookup: resolve })
  }
  return async (url, init) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, "")
    // An address in the URL is connected to without a lookup, so it is checked here.
    if (isIP(hostname) !== 0 && !exemptHostname(hostname, policy) && !permittedAddress(hostname, policy)) {
      throw new DestinationRefused(hostname)
    }
    const request = new Request(url, init)
    const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer())
    const headers = new Headers(request.headers)
    // `fetch` would ask for compression and decode it; answers are decoded above when a server compresses anyway.
    headers.delete("accept-encoding")
    if (body !== undefined) headers.set("content-length", String(body.byteLength))
    const secure = url.protocol === "https:"
    return new Promise<Response>((accept, reject) => {
      const outgoing = (secure ? httpsRequest : httpRequest)(
        url,
        {
          method: request.method,
          headers: Object.fromEntries(headers),
          agent: secure ? agents.https : agents.http,
          lookup: resolve,
          signal: request.signal
        },
        (incoming) => accept(toResponse(incoming, request.method))
      )
      outgoing.on("error", reject)
      outgoing.end(body)
    })
  }
}
