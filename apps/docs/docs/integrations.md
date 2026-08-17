# Integrations CLI

`integrations` is a thin client over the **gateway**: the local service that
holds every connection and credential, resolves grants, decides authorization
policy, and performs invocations. Nothing else ever sees a credential. It also
installs as `i`, so `i tools linear` and `integrations tools linear` are the
same command.

```bash
integrations --help
```

The command needs Bun on the machine. It ships in
`@mokronos/integrations-cli`, a dependency of `@mokronos/wf` — not yet published
to npm, so install it from the repository with `bun run install:local`, which
puts `wf`, `integrations`, and `i` on your `PATH`.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Integration** | An external system in the catalog — Gmail, Slack, a GitHub API. Discovered from a standardised description, never hand-authored |
| **Tool** | One named operation an integration exposes, with its own input and output schemas. The smallest unit that can be invoked, granted, or approved |
| **Connection** | A stored authorization letting you use an integration. Holds references exchanged for credentials at the moment of use |
| **Connection name** | The label distinguishing several connections to one integration — three Google accounts as `personal`, `work`, `client-x`. Defaults to `default` |
| **Owner tier** | Which partition a connection is filed under: `org` (shared by the tenant) or `user` (private to one subject) |
| **Client** | Anything that calls the gateway — an agent, a workflow runner, a script. Has no inherent access |
| **API key** | The credential a client presents. Identifies the client and nothing else |
| **Grant** | A delegation: one client may invoke one tool through one connection. The only source of a client's access |
| **Alias** | The logical name a grant exposes a tool under. A caller declares it as a requirement; each deployment binds it — an environment variable, not a pointer |
| **Pending approval** | An invocation frozen awaiting a human decision. Approving discharges that one invocation and confers no capability |
| **Drift** | A divergence between the catalog's recorded shape of a tool and what the vendor now exposes |

## Starting the gateway

Every command goes through the gateway; there is no local fallback.

```bash
integrations serve
```

| Flag | Meaning |
| --- | --- |
| `--port <integer>` | Port to listen on. Defaults to 4788 (the dashboard already owns 4787) |
| `--host <string>` | Bind address. Defaults to `127.0.0.1` |

On start it ensures a local privileged client exists, mints a key for it, and
writes `~/.wf/gateway.json` (mode `0600`) with the URL and that key — so the
local case is zero-configuration. Clients read it automatically; set
`INTEGRATIONS_URL` and `INTEGRATIONS_API_KEY` to point somewhere else instead.

> Binding outside loopback exposes a credential that unlocks every connection
> the client holds. Terminate TLS in front of it and treat it as a deliberate
> act.

If nothing is running you get: *No gateway found. Start one with `integrations
serve`, or set INTEGRATIONS_URL and INTEGRATIONS_API_KEY.*

## Output conventions

Integration commands return JSON by default — the reader is usually an agent.
Add `--text` for a human-readable result and `--verbose` (`-v`) for complete
objects. Listings are bounded with a `Showing N of M` hint; `--verbose` opts
out.

A `403` is reported as *this key is not permitted; use a key whose client may
mutate* — the fix is a different key, not a different request.

## Discovery and connections

Start from a URL rather than guessing protocol, auth, operation names, or
schemas.

### search

```text
integrations search [flags] <query>
```

| Flag | Meaning |
| --- | --- |
| `--kind <mcp\|openapi\|graphql\|cli>` | Limit results to one integration kind |
| `--limit <integer>` | Maximum results. Default 5, range 1–100 |
| `--text`, `--verbose` | Output mode |

Queries the public integrations.sh catalog and returns the preferred discovery
URL for each result.

### discover

```text
integrations discover [flags] <url>
```

| Flag | Meaning |
| --- | --- |
| `--connection <name>` | Connection name. Default `default` |
| `--text`, `--verbose` | Output mode |

Runs the whole chain: URL → protocol detection (MCP or OpenAPI) → integration
registration → auth discovery → connection when the service is public → tool
names and input/output schemas. If auth is required, the result includes the
available auth templates and the integration slug to connect.

### connect

```text
integrations connect [flags] <integration>
```

| Flag | Meaning |
| --- | --- |
| `--connection <name>` | Connection name. Default `default` |
| `--template <name>` | Which discovered auth method to use |
| `--credential-env <NAME>` | Environment variable holding an API key or bearer token |
| `--credential-values <var=ENV,...>` | Comma-separated mappings for multi-value auth methods |
| `--client-id`, `--client-secret-env` | Pre-registered OAuth client, when dynamic registration is unavailable |
| `--no-open` | Print the authorization URL instead of launching a browser |
| `--timeout <integer>` | How long to wait for the OAuth callback |

OAuth discovers authorization metadata, registers a client dynamically when
supported, and runs authorization code + PKCE against a loopback callback.
Never put a secret value on the command line — name the environment variable
holding it. Credentials are AES-GCM encrypted in `~/.wf/executor-auth.json`
under the user-only key `~/.wf/executor-auth.key`.

### connections, disconnect, list

```bash
integrations connections            # every connection, no credentials exposed
integrations list                   # the persisted integration catalog
integrations disconnect <integration> [--connection <name>]
```

## Inspecting tools

Browse names first, then pull the schema for the one tool you settle on — a
hundred JSON Schemas is not a useful answer.

```text
integrations tools [flags] <integration>
integrations schema [flags] <integration> <tool>
```

| Flag | Meaning |
| --- | --- |
| `--search <text>` | (`tools`) Keep only tools whose name or description contains this text |
| `--connection <name>` | (`schema`) Which connection to read the schema through |
| `--text`, `--verbose` | Output mode |

`schema` returns the tool's address, description, and complete input and output
schemas — mirror those in a workflow's `input` and `output`, and author the node
with the alias and tool name only.

Generic MCP envelopes are normalized before they reach callers: structured
content is returned directly, JSON text is parsed, and plain text stays a
string.

## Invoking

```text
integrations invoke [flags] <tool-address> [<json>]     # privileged
integrations execute [flags] <alias> <tool> [<json>]    # delegated
```

`invoke` takes a resolved tool address and is **privileged** — it is how you
prove a connection works right after making it, not how production calls
happen. `execute` takes an alias and a tool and is what a delegated caller uses:
it can only reach what a grant exposes to its key. Both accept `--file` to read
the JSON input from a file.

```text
integrations validate [flags] [<json-or-tool-address>]
```

Validates a tool address or an integration node config; `--live` checks it
against the connected integration.

## Delegation

A client is created, given a key, and granted specific tools. That is the only
source of its access.

```bash
integrations client "orders-agent" --may-mutate     # omit the flag for read-only access
integrations key <client-id>                        # shown once
integrations grant <client-id> <alias> <tool> --integration <slug>
integrations grants <client-id>
integrations granted                                # what this key itself can reach
integrations clients
```

| `grant` flag | Meaning |
| --- | --- |
| `--integration <slug>` | The integration the alias resolves to |
| `--connection <name>` | Connection name. Default `default` |
| `--owner <org\|user>` | Which tier the connection is filed under |
| `--subject <id>` | Required for a user-tier connection: the human it belongs to |
| `--require-approval` | Freeze this tool's calls for a human instead of running them |

The alias is what a workflow declares. Binding it here is what lets one
definition run for different people against their own accounts, without editing
its source.

## Approvals

```bash
integrations approvals [--status pending|approved|denied|expired]
integrations approve <approval-id> [--by <who>]
integrations deny <approval-id> [--by <who>]
```

A frozen invocation expires if nobody decides it, and expiry means the
invocation does not happen. On approval the gateway performs the call itself —
the caller never gains the capability; it just reads the stored result on its
next attempt. A workflow's integration step simply retries until the decision
lands.

## Audit and drift

```bash
integrations audit [--limit <n>]
integrations drift [<integration>]
```

The audit trail records every invocation attempt: client, alias, resolved
connection, subject acted for, tool, decision, outcome. It is retained
permanently; the arguments attached to it are not.

`drift` re-reads a vendor's tools and reports what was added, removed, or
reshaped since the last sync — the cue to regenerate typed bindings.

## Codegen

```text
integrations codegen [--target effect|ts] [--out <file>]
```

| Target | Emits |
| --- | --- |
| `effect` | Effect Schema types plus ready-made `integration()` steps for `@mokronos/wfkit` |
| `ts` | TypeScript types plus typed calls over `@mokronos/integrations-client` |

Generation runs against *your* gateway with *your* key, so the generated surface
is exactly the grant surface: least privilege shows up in autocomplete, and
adding a tool means adding a grant. See the [Gateway client](client.md) for
what the output looks like.
