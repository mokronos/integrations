import { describe, expect, test } from "bun:test"
import {
  isLoopbackAddress,
  isLoopbackHostHeader,
  mayBorrowLocalCredential
} from "../src/index.ts"
import type { LoopbackBootstrap } from "../src/index.ts"

const bootstrap = (overrides: Partial<LoopbackBootstrap> = {}): LoopbackBootstrap => ({
  boundToLoopback: true,
  port: 4788,
  remoteAddress: "127.0.0.1",
  ...overrides
})

/** A request as the browser would send it, unless a test says otherwise. */
const request = (headers: Readonly<Record<string, string>>): Request =>
  new Request("http://127.0.0.1:4788/v1/clients", {
    headers: { "sec-fetch-site": "same-origin", ...headers }
  })

describe("isLoopbackAddress", () => {
  test("accepts the whole 127/8 range and both spellings of ::1", () => {
    for (const address of ["127.0.0.1", "127.0.0.53", "127.255.255.254", "::1", "0:0:0:0:0:0:0:1", "[::1]"]) {
      expect(isLoopbackAddress(address)).toBe(true)
    }
  })

  test("accepts IPv4 peers reported in the mapped form", () => {
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true)
    expect(isLoopbackAddress("::ffff:10.0.0.4")).toBe(false)
  })

  test("rejects everything else, including addresses that merely start with 127", () => {
    for (const address of ["10.0.0.1", "192.168.1.9", "1270.0.0.1", "127.0.0.1.evil.com", "", undefined]) {
      expect(isLoopbackAddress(address)).toBe(false)
    }
  })
})

describe("isLoopbackHostHeader", () => {
  test("accepts loopback names with and without a port", () => {
    for (const host of ["127.0.0.1:4788", "127.0.0.1", "localhost:4788", "LocalHost", "[::1]:4788"]) {
      expect(isLoopbackHostHeader(host)).toBe(true)
    }
  })

  test("rejects a rebinding attacker's own name", () => {
    // Resolves to 127.0.0.1, so the connection really does arrive on loopback —
    // the Host header is the only thing that gives it away.
    expect(isLoopbackHostHeader("attacker.example.com:4788")).toBe(false)
    expect(isLoopbackHostHeader("localhost.attacker.com")).toBe(false)
    expect(isLoopbackHostHeader(null)).toBe(false)
  })
})

describe("mayBorrowLocalCredential", () => {
  test("a same-origin request from the control plane may borrow", () => {
    expect(mayBorrowLocalCredential(
      request({ host: "127.0.0.1:4788", origin: "http://127.0.0.1:4788" }),
      bootstrap()
    )).toBe(true)
  })

  test("localhost and [::1] are the same origin as far as the browser is concerned", () => {
    for (const origin of ["http://localhost:4788", "http://[::1]:4788"]) {
      expect(mayBorrowLocalCredential(
        request({ host: "localhost:4788", origin }),
        bootstrap()
      )).toBe(true)
    }
  })

  test("a same-origin GET may borrow: the browser sends no Origin on those", () => {
    expect(mayBorrowLocalCredential(request({ host: "127.0.0.1:4788" }), bootstrap())).toBe(true)
  })

  test("a caller that is not a browser may not: it can carry a key", () => {
    // curl and the CLI send no Sec-Fetch-Site. Nothing about the API surface
    // changes for them — bring your own credential, as before.
    const bare = new Request("http://127.0.0.1:4788/v1/clients", {
      headers: { host: "127.0.0.1:4788" }
    })
    expect(mayBorrowLocalCredential(bare, bootstrap())).toBe(false)
  })

  test("a cross-site page may not, whatever it claims", () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      expect(mayBorrowLocalCredential(
        request({ host: "127.0.0.1:4788", "sec-fetch-site": site }),
        bootstrap()
      )).toBe(false)
    }
  })

  test("a page on any other site may not, however local it looks", () => {
    for (const origin of [
      "https://evil.example.com",
      "http://127.0.0.1:5173",
      "http://localhost:3000",
      "null"
    ]) {
      expect(mayBorrowLocalCredential(
        request({ host: "127.0.0.1:4788", origin }),
        bootstrap()
      )).toBe(false)
    }
  })

  test("a rebound hostname may not, even though the socket is loopback", () => {
    expect(mayBorrowLocalCredential(
      request({ host: "totally-legit.example.com:4788" }),
      bootstrap()
    )).toBe(false)
  })

  test("a remote peer may not", () => {
    expect(mayBorrowLocalCredential(
      request({ host: "127.0.0.1:4788", origin: "http://127.0.0.1:4788" }),
      bootstrap({ remoteAddress: "10.1.2.3" })
    )).toBe(false)
  })

  test("nobody may, once the gateway is bound off loopback", () => {
    // A proxy on the same box would make every forwarded request look local,
    // so the whole equivalence argument stops holding.
    expect(mayBorrowLocalCredential(
      request({ host: "127.0.0.1:4788", origin: "http://127.0.0.1:4788" }),
      bootstrap({ boundToLoopback: false })
    )).toBe(false)
  })

  test("the port has to match: another local server is another origin", () => {
    expect(mayBorrowLocalCredential(
      request({ host: "127.0.0.1:4788", origin: "http://127.0.0.1:4788" }),
      bootstrap({ port: 9999 })
    )).toBe(false)
  })
})
