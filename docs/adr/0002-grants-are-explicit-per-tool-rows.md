# Grants are explicit per-tool rows

Integrations are discovered from MCP servers and OpenAPI specs rather than
hand-authored, so tool names belong to vendors and change when they redeploy. A
grant is therefore one explicit row per `(client, connection, tool)` with no
pattern matching: a vendor shipping a new `deleteAllDocuments` in next week's
release must not silently land inside every existing grant. Since invocations
are allowed by default once granted, the grant list is the entire safety
boundary, and it should not be able to grow without a human.

## Considered options

- **Patterns** (`sharepoint.*`) — rejected outright. Wildcards over a namespace
  we do not control combine the drawbacks of both alternatives.
- **Connection-level grants** ("everything on this connection") — available as
  an explicit, visibly broad option, but not the default.

## Consequences

- Newly discovered tools are unreachable until someone grants them. This is the
  intended failure direction, but it makes them easy to miss, so the drift
  report surfaces additions as well as renames and removals.
- Denial is the absence of a grant; there is no deny state. Discovery is
  grant-scoped, so an ungranted tool is invisible rather than visible-then-
  failing, which is the property a deny state would otherwise have provided. A
  grant carries `allow | require_approval` and nothing else.
- Invocation by resolved tool address stays available for ergonomics, but
  resolves first and then checks the resulting `(connection, tool)` against the
  caller's grants like any other call. Without that check, address-invocation
  would walk around delegation entirely.
