import { describe, expect, it } from "vitest"
import { argumentAt, splitArguments } from "../src/lib/approval-groups.ts"

describe("splitArguments", () => {
  it("keeps what every call agrees on and lists only the paths that differ", () => {
    const calls = ["a", "b", "c"].map((name) => ({
      to: [`${name}@example.com`],
      subject: "Launch",
      options: { html: true, tracking: { campaign: name } }
    }))

    const { shared, varying } = splitArguments(calls)

    expect(shared).toEqual({ subject: "Launch", options: { html: true } })
    expect(varying).toEqual([["to"], ["options", "tracking", "campaign"]])
    expect(argumentAt(calls[1] ?? {}, ["options", "tracking", "campaign"])).toBe("b")
  })

  it("treats a field only some calls send as differing", () => {
    const { shared, varying } = splitArguments([
      { subject: "Launch", cc: "boss@example.com" },
      { subject: "Launch" }
    ])

    expect(shared).toEqual({ subject: "Launch" })
    expect(varying).toEqual([["cc"]])
  })
})
