import { describe, expect, test } from "@effect/vitest"
import { Schema } from "effect"
import {
  Alias,
  aliasForConnection,
  ConnectionName,
  IntegrationSlug,
  SubjectId
} from "../src/domain.ts"
import type { ConnectionRef } from "../src/domain.ts"

const org = (integration: string, name: string): ConnectionRef => ({
  owner: "org",
  integration: IntegrationSlug.make(integration),
  name: ConnectionName.make(name)
})

const user = (subject: string, integration: string, name: string): ConnectionRef => ({
  owner: "user",
  subject: SubjectId.make(subject),
  integration: IntegrationSlug.make(integration),
  name: ConnectionName.make(name)
})

const isAlias = Schema.is(Alias)
/** Generated code reaches a tool as `tools.<alias>.<tool>()`, so the alias has to be addressable. */
const isJsIdentifier = (value: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)

describe("naming a connection", () => {
  test("reads as its parts, separated by the joiner", () => {
    expect(String(aliasForConnection(org("linear", "work")))).toBe("org___linear___work")
    expect(String(aliasForConnection(user("sebastian", "linear", "work")))).toBe(
      "user___sebastian___linear___work"
    )
  })

  test("carries an underscore inside a part through as itself", () => {
    expect(String(aliasForConnection(org("mcp_linear_app", "default")))).toBe(
      "org___mcp_linear_app___default"
    )
  })

  test("widens a hyphen, which is not addressable in generated code", () => {
    expect(String(aliasForConnection(org("linear", "client-x")))).toBe("org___linear___client__x")
    expect(String(aliasForConnection(org("github-mcp", "default")))).toBe(
      "org___github__mcp___default"
    )
  })

  test("escapes a subject, because an identity provider chose it", () => {
    expect(String(aliasForConnection(user("local-operator", "linear", "work")))).toBe(
      "user___local__2doperator___linear___work"
    )
    // An escaped leading byte merges with the joiner. No part can ever *end*
    // in an underscore, and the subject is the only part that can begin with
    // one, so the longer run still marks exactly one boundary.
    expect(String(aliasForConnection(user("A1", "linear", "work")))).toBe(
      "user_____411___linear___work"
    )
  })

  test("keeps apart two connections a naive join would merge", () => {
    expect(aliasForConnection(org("a_b", "c"))).not.toBe(aliasForConnection(org("a", "b_c")))
    expect(aliasForConnection(org("a-b", "c"))).not.toBe(aliasForConnection(org("a_b", "c")))
    expect(aliasForConnection(org("a", "b"))).not.toBe(
      aliasForConnection(user("a", "a", "b"))
    )
  })

  test("tells a delegation template apart from one subject's connection", () => {
    expect(aliasForConnection({
      owner: "user",
      integration: IntegrationSlug.make("gmail"),
      name: ConnectionName.make("work")
    })).not.toBe(aliasForConnection(user("sebastian", "gmail", "work")))
  })

  test("refuses a part that could grow the joiner", () => {
    for (const part of ["a__b", "_a", "a_", "a--b", "a-_b"]) {
      expect(() => IntegrationSlug.make(part)).toThrow()
      expect(() => ConnectionName.make(part)).toThrow()
    }
  })

  test("never lets two connections share an alias", () => {
    const chars = ["a", "1", "_", "-", "A"]
    const grow = (prefix: string, depth: number, out: Array<string>): Array<string> => {
      if (prefix.length > 0) out.push(prefix)
      if (depth === 0) return out
      for (const character of chars) grow(prefix + character, depth - 1, out)
      return out
    }
    const candidates = grow("", 3, [])
    const slugs = candidates.filter((value) => Schema.is(IntegrationSlug)(value))
    const subjects = candidates.filter((value) => Schema.is(SubjectId)(value))
    const shortSlugs = slugs.filter((value) => value.length <= 2)
    expect(slugs.length).toBeGreaterThan(20)

    const owners = new Map<string, string>()
    const claim = (reference: ConnectionRef) => {
      const alias = String(aliasForConnection(reference))
      const key = JSON.stringify(reference)
      expect(owners.get(alias) ?? key).toBe(key)
      owners.set(alias, key)
      expect(isAlias(alias)).toBe(true)
      expect(isJsIdentifier(alias)).toBe(true)
    }

    for (const integration of slugs) {
      for (const name of slugs) {
        claim(org(integration, name))
        claim({
          owner: "user",
          integration: IntegrationSlug.make(integration),
          name: ConnectionName.make(name)
        })
      }
    }
    for (const subject of subjects) {
      for (const integration of shortSlugs) {
        for (const name of shortSlugs) claim(user(subject, integration, name))
      }
    }
  })

  test("produces something the wire and generated code both accept", () => {
    for (const reference of [
      org("linear", "work"),
      org("mcp_linear_app", "default"),
      org("github-mcp", "default"),
      org("linear", "client-x"),
      user("local-operator", "linear", "work"),
      user("A1", "mcp_linear_app", "client-x")
    ]) {
      const alias = String(aliasForConnection(reference))
      expect(isAlias(alias)).toBe(true)
      expect(isJsIdentifier(alias)).toBe(true)
    }
  })
})
