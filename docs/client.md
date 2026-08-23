# Gateway client

`@mokronos/integrations-client` is the TypeScript client for the integration
gateway. It is deliberately dumb: authenticate, send, decode. Every decision
about whether a call may happen, which connection serves it, and whether a human
is asked lives behind the gateway.

That split is the point — the public client has no generic HTTP escape hatch
and cannot express gateway administration. A sandbox holding it may provision
connections, while invocation remains limited to the grants attached to its
key.

The package is not published to npm yet; inside this repository it resolves as a
workspace dependency.

```ts
import { createGatewayClient, resolveClientConnection } from "@mokronos/integrations-client"

const connection = await resolveClientConnection()
if (connection === undefined) throw new Error("No gateway configured")

const gateway = createGatewayClient(connection)
const outcome = await gateway.execute({
  alias: "issues",
  tool: "create_issue",
  arguments: { team: "ENG", title: "Durable workflows" }
})
```

## Finding the gateway

`resolveClientConnection(env?)` returns `{ url, apiKey }` or `undefined`:

1. `INTEGRATIONS_URL` + `INTEGRATIONS_API_KEY`, if both are set — so a sandbox
   can be pointed at a remote gateway without touching disk;
2. otherwise `gateway.json` in `INTEGRATIONS_HOME` or `~/.integrations`, which
   the local gateway writes when it starts.

| Export | Meaning |
| --- | --- |
| `resolveClientConnection(env?)` | The lookup above |
| `readGatewayConfig(home)` / `writeGatewayConfig(home, config)` | Read and write `gateway.json` (written `0600` — the file is a credential) |
| `gatewayConfigPath(home)` | Its location |
| `integrationsHome(env?)` | Resolve the storage directory |
| `defaultGatewayPort` | `4788` |
| `GatewayConfigFile` | The Effect schema for the file: `{ port, url, apiKey }` |

## createGatewayClient

```ts
createGatewayClient({ url, apiKey, fetch? })
```

`fetch` is injectable for tests or to route through a proxy. Requests carry
`authorization: Bearer <apiKey>`.

Every successful JSON response is decoded at runtime with an exported Effect
Schema. The TypeScript return type is derived from that same schema, so a
gateway/client contract mismatch fails at the network boundary instead of
leaking an unvalidated JSON value into the caller.

| Method | Return type / schema | Meaning |
| --- | --- | --- |
| `search(input)` / `discover(input)` | `IntegrationSearchResponse` / `IntegrationDiscovery` | Search the registry and register a discovered integration |
| `integrations()` | `GatewayIntegrationsResponse` | List the persisted integration catalog |
| `integrationTools(integration)` / `integrationTool(input)` | `IntegrationToolsResponse` / `ExecutorTool` | Inspect tool names and schemas |
| `connect(input)` | `ConnectionCreated` | Create a connection |
| `startOAuth(input)` / `oauth(id)` | `OAuthSession` | Start or inspect an OAuth flow |
| `connections()` / `disconnect(input)` | `ConnectionsResponse` / `DisconnectedConnection` | List or remove connections without exposing credentials |
| `validate(input)` | `IntegrationValidationReport` | Validate an integration node or resolved address |
| `tools({ schemas? })` | `ReadonlyArray<GrantedTool>` | The tools this key can reach. Grant-scoped, so an ungranted tool is absent rather than present-and-failing. Schemas are opt-in because they cost a catalog read per grant |
| `execute({ alias, tool, arguments? })` | `InvocationOutcome` | Invoke a granted tool through its alias |
| `approval(id)` | `ApprovalRecord` | Read one approval record proposed by this client |
| `health()` | `boolean` | `true` if the gateway answers |
| `url` | `string` | The normalized base URL |

The input contracts (`RegistrySearchInput`, `DiscoverIntegrationInput`,
`CreateConnectionInput`, and the other method inputs) are exported schemas as
well. Use `typeof SchemaName.Type` only when you need to derive another type;
the package already exports the corresponding type names for ordinary callers.

API keys carry explicit client capabilities. A normal client gets
`provision_connections`, which covers catalog discovery, schema inspection,
connection creation/removal, and validation. Delegated invocation is separate:
`GET /v1/tools`, `POST /v1/execute`, and `GET /v1/approvals/:id` are constrained
by that client's grants. An operator-created key may additionally carry
`administer_gateway`, but approval and denial always require a human session or
the trusted local dashboard context; no API key can make a human decision.

### GrantedTool

```ts
{
  alias: string
  tool: string
  integration: string
  decision: "allow" | "require_approval"
  inputSchema?: Json
  outputSchema?: Json
}
```

### InvocationOutcome

`execute` never throws for an authorization decision; it returns one of four
outcomes:

| Status | Shape | Meaning |
| --- | --- | --- |
| `succeeded` | `{ status, result }` | The gateway performed the call |
| `pending` | `{ status, approvalId, expiresAt }` | Frozen for a human. Poll `approval(approvalId)` |
| `denied` | `{ status, reason }` | Policy refused it |
| `failed` | `{ status, message }` | The call was attempted and failed |

Every answer the policy produced is a value, `denied` and `failed` included:
the gateway answered, and which answer it gave is yours to branch on. They
travel on 403 and 502 so HTTP callers see them too, but `execute` decodes them
rather than throwing. A thrown `GatewayError` means the gateway did not answer
at all — bad key, no route, unreachable — and carries `status`, `body`, and a
message taken from the gateway's `error` or the outcome's `reason`.

`pending` is a first-class outcome rather than an error: blocking would hold a
sandbox process open across a human's lunch break. Either way of waiting works:

```ts
const outcome = await gateway.execute({ alias: "issues", tool: "create_issue", arguments: input })
if (outcome.status === "pending") {
  // Poll the record…
  const record = await gateway.approval(outcome.approvalId)
  // record.status: "pending" | "approved" | "denied" | "expired"
  // record.result once approved; record.collectedAt once handed back

  // …or just call again. The same arguments meet the same frozen call rather
  // than asking a human twice, and the decision is delivered once it lands.
  const later = await gateway.execute({ alias: "issues", tool: "create_issue", arguments: input })
}
```

That is what makes a retrying durable step correct: the retry is not a second
request. Once the outcome has been collected, though, an identical call *is* a
new request and needs its own decision — one approval is one invocation, never
standing permission.

## Generated bindings

Rather than hand-transcribing schemas, generate them. The catalog is discovered
per tenant at runtime, so there is no build-time catalog to ship — generation
runs against your gateway with your key, which has a useful consequence: the
generated surface *is* the grant surface.

```bash
i codegen --target ts --out src/tools.ts
i codegen --target effect --out src/workflow-tools.ts
```

### The `ts` target

Typed calls over this client:

```ts
// Generated by `i codegen --target ts`. Do not edit.
import type { GatewayClient, InvocationOutcome } from "@mokronos/integrations-client"

export type TicketsTicketsCreateInput = {
  readonly "title": string
  readonly "priority"?: number
  readonly "labels"?: ReadonlyArray<string>
}

export type TicketsTicketsCreateOutput = {
  readonly "id": string
  readonly "title": string
}

/** `tickets.tickets.create` on acceptance. */
export const ticketsTicketsCreate = (
  client: GatewayClient,
  input: TicketsTicketsCreateInput
): Promise<InvocationOutcome> =>
  client.execute({
    alias: "tickets",
    tool: "tickets.create",
    arguments: input
  })
```

### The `effect` target

Effect Schema plus ready-made `integration()` steps for `@mokronos/wfkit`:

```ts
// Generated by `i codegen --target effect`. Do not edit.
import { integration, t } from "@mokronos/wfkit"

export const TicketsTicketsCreateInput = t.struct({
  "title": t.string,
  "priority": t.optional(t.number)
})

export const ticketsTicketsCreate = integration({
  source: { kind: "gateway", alias: "tickets", tool: "tickets.create" },
  input: TicketsTicketsCreateInput,
  output: TicketsTicketsCreateOutput,
  retry: { attempts: 3, backoff: "exponential" }
})
```

Names are derived from `alias` + `tool`, so `gmail-work` + `send_email` becomes
`gmailWorkSendEmail` and dotted vendor tool names stay valid identifiers. A tool
whose grant requires approval says so in its doc comment.

Where a vendor's JSON Schema uses a construct the generator does not model, it
emits the permissive type (`unknown` / `t.unknown`) rather than guessing: a
wrong-but-narrow type would reject calls the gateway would have accepted.

Regenerate after `ii grant`, or when `ii drift` reports a
vendor change — a reshaped schema then fails typecheck instead of failing at
3am.

### Programmatic generation

The generator is exported, so you can drive it yourself:

| Export | Meaning |
| --- | --- |
| `generateModule(target, tools, gatewayUrl)` | Dispatch on `"ts"` or `"effect"` |
| `generateTypeScriptModule(tools, gatewayUrl)` / `generateEffectModule(tools, gatewayUrl)` | The two targets directly |
| `bindingName(alias, tool)` / `typeName(alias, tool, suffix)` | The identifier derivation |
| `GeneratableTool`, `CodegenTarget` | Input types — `GrantedTool` from `tools({ schemas: true })` satisfies `GeneratableTool` |

## Using it from a workflow

Workflows do not use this client directly. [`wf`](cli.md) is the composition root: it
turns a workflow's `{ alias, tool }` into `gateway.execute(...)`, and maps the
outcomes onto durable semantics — `pending` and `failed` are thrown so the
durable engine retries them, and a denial fails the step. A daemon restart, or a
human who has not decided yet, is a blip a durable run rides out.
