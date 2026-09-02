import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  Alias,
  aliasForConnection,
  ConnectionName,
  IntegrationSlug,
  SubjectId
} from "../src/domain.ts"
import type { ConnectionRef } from "../src/domain.ts"

/** The alias is how a caller names one connection, and `authorizeInvocation`
 *  resolves a call by matching it. So it has to be readable enough to type and
 *  injective enough to trust, and the two pull against each other. */

const org = (integration: string, name: string): ConnectionRef => ({
  owner: "org",
  integration: IntegrationSlug.make(integration),
  name: ConnectionName.make(name)
})

const isAlias = Schema.is(Alias)

describe("naming a connection", () => {
  test("reads as its parts, separated once", () => {
    expect(String(aliasForConnection(org("linear", "work")))).toBe("org_linear_work")
    expect(String(aliasForConnection({
      owner: "user",
      subject: SubjectId.make("sebastian"),
      integration: IntegrationSlug.make("linear"),
      name: ConnectionName.make("work")
    }))).toBe("user_sebastian_linear_work")
  })

  test("escapes a separator that appears inside a part", () => {
    // A slug may hold `_`; an alias part may not, or the join would be a guess.
    const alias = String(aliasForConnection(org("mcp_linear_app", "default")))
    expect(alias).toBe("org_mcp-5flinear-5fapp_default")
    expect(alias.split("_")).toHaveLength(3)
  })

  test("keeps apart two connections a naive join would merge", () => {
    // Without escaping both of these read `org_a_b_c`, and whichever policy row
    // matched first would answer for the other's credential.
    expect(aliasForConnection(org("a_b", "c"))).not.toBe(aliasForConnection(org("a", "b_c")))
  })

  test("escapes a hyphen too, because that is the escape marker", () => {
    // The price of an encoder that has to be total: a subject identifier is an
    // unconstrained string, so one marker has to be reserved, and `-` is it.
    expect(String(aliasForConnection(org("linear", "client-x")))).toBe("org_linear_client-2dx")
  })

  test("produces something the wire accepts", () => {
    for (const reference of [
      org("linear", "work"),
      org("mcp_linear_app", "default"),
      org("linear", "client-x")
    ]) {
      expect(isAlias(String(aliasForConnection(reference)))).toBe(true)
    }
  })
})
