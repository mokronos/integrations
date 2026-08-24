# @mokronos/contracts

The shared vocabulary and wire contracts every component of this system agrees
on. Depends on `effect` and nothing else, so a browser or a published client can
decode a gateway response without acquiring the host's dependency graph.

| Module | Holds |
| --- | --- |
| `vocabulary.ts` | The branded identifiers: `IntegrationSlug`, `ConnectionName`, `ToolName`, `OwnerTier`, `Alias` |
| `address.ts` | `ToolAddress`, `ConnectionAddress`, and the functions that build and parse them |
| `integration.ts` | `Integration`, `AuthMethod`, `AuthPlacement`, `EndpointDetection`, `McpProbe`, `OpenApiPreview` |
| `connection.ts` | `Connection` |
| `tool.ts` | `Tool`, `ToolSummary` |
| `oauth.ts` | `OAuthServerProbe`, `OAuthStart` |
| `overview.ts` | The dashboard aggregates |
| `discovery.ts` | What inspecting an endpoint returns, and what `integrations validate` accepts |
| `registry.ts` | integrations.sh search shapes |
| `version.ts` | The negotiated protocol version |
| `json.ts`, `optional.ts` | The two helpers every boundary uses |

## Why the vocabulary lives here

`Schema.brand("IntegrationSlug")` keys the brand on the string, so two
independent definitions of the same name produce the *same* TypeScript type
while validating differently. When the gateway and the host each had their own,
the gateway could hand the host a slug the host would have rejected and the
compiler said nothing. One definition per name is what closes that.
