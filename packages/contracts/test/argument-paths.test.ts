import { describe, expect, it } from "vitest"
import { argumentPattern, matchesPattern, patternProblem } from "../src/index.ts"

const pattern = argumentPattern([
  { to: ["a@example.com"], subject: "Launch", options: { html: true } },
  { to: ["b@example.com"], subject: "Launch", options: { html: true } }
])

describe("argument patterns", () => {
  it("pins what the calls share and leaves what differs open", () => {
    expect(pattern).toEqual({
      pinned: [{ path: ["subject"], value: "Launch" }, { path: ["options", "html"], value: true }],
      free: [["to"]]
    })
  })

  it("matches a new value in an open field, in any key order", () => {
    expect(matchesPattern(pattern, { options: { html: true }, subject: "Launch", to: ["c@example.com", "d@example.com"] })).toBe(true)
  })

  it("refuses a changed pinned value, a missing one, or a field it never saw", () => {
    expect(matchesPattern(pattern, { to: ["c@example.com"], subject: "Other", options: { html: true } })).toBe(false)
    expect(matchesPattern(pattern, { to: ["c@example.com"], options: { html: true } })).toBe(false)
    expect(matchesPattern(pattern, { to: ["c@example.com"], subject: "Launch", options: { html: true }, bcc: "x@example.com" })).toBe(false)
    expect(matchesPattern(pattern, { to: ["c@example.com"], subject: "Launch", options: { html: true, tracking: true } })).toBe(false)
  })

  it("rejects patterns that open everything or pin inside an open field", () => {
    expect(patternProblem({ pinned: [], free: [[]] })).toBeDefined()
    expect(patternProblem({ pinned: [{ path: ["to", "name"], value: "a" }], free: [["to"]] })).toBeDefined()
    expect(patternProblem(pattern)).toBeUndefined()
  })
})
