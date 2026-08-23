import { describe, expect, test } from "bun:test"
import { toolDefaultDecision } from "../src/tools.ts"

/** The annotations the MCP plugin persists per tool row: its own
 *  `requiresApproval` (derived from `destructiveHint`) plus a stamp of the
 *  server's untouched MCP annotations. Shaped after real rows read out of
 *  Google's Gmail MCP server. */
const stamped = (
  requiresApproval: boolean,
  upstream: {
    readonly readOnlyHint?: boolean
    readonly destructiveHint?: boolean
  }
) => ({
  requiresApproval,
  mcp: { toolName: "tool", upstream: { title: "Tool", ...upstream } }
})

/** The plugin derives `requiresApproval` from `destructiveHint`, so the two
 *  always agree on a row it wrote. */
const mcpAnnotations = (upstream: {
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
}) => stamped(upstream.destructiveHint === true, upstream)

describe("toolDefaultDecision", () => {
  test("allows a tool the server declares read-only", () => {
    // search_threads, list_labels, get_message …
    expect(toolDefaultDecision(mcpAnnotations({ readOnlyHint: true, destructiveHint: false })))
      .toBe("allow")
  })

  test("requires approval for a mutating tool the server calls non-destructive", () => {
    // create_draft writes to the mailbox. `destructiveHint: false` — and so the
    // plugin's `requiresApproval: false` — is not permission to skip review.
    expect(toolDefaultDecision(mcpAnnotations({ readOnlyHint: false, destructiveHint: false })))
      .toBe("require_approval")
  })

  test("requires approval for a destructive tool", () => {
    // trash_thread, mark_message_spam …
    expect(toolDefaultDecision(mcpAnnotations({ readOnlyHint: false, destructiveHint: true })))
      .toBe("require_approval")
  })

  test("requires approval when the plugin flags the tool, whatever it claims upstream", () => {
    expect(toolDefaultDecision(stamped(true, { readOnlyHint: true })))
      .toBe("require_approval")
  })

  test("requires approval for a source that declares nothing", () => {
    // An OpenAPI GET: the plugin annotates only the mutating methods, so a
    // read-only operation arrives indistinguishable from an unclassified one.
    expect(toolDefaultDecision({})).toBe("require_approval")
    expect(toolDefaultDecision(undefined)).toBe("require_approval")
  })

  test("requires approval when the stamp is present but says nothing about reads", () => {
    expect(toolDefaultDecision(stamped(false, {}))).toBe("require_approval")
  })
})
