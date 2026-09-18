# Integrations Gateway

The integrations gateway connects external tool providers to agents while keeping resource access and human-approval requirements independently configurable.

## Language

**Client**:
An agent-facing security principal with one or more API keys and assigned access and approval configuration.
_Avoid_: CLI, SDK, API key

**OAuth application**:
An external MCP program that requests delegated access to the gateway.
_Avoid_: Client, Gateway Client

**OAuth grant**:
A person's revocable authorization for an OAuth application to act as a particular Client.
_Avoid_: Login session, API key

**Access profile**:
A reusable set of connections and tools that a client is allowed to discover and invoke.
_Avoid_: Approval policy, permissions policy

**Approval policy**:
A complete set of decisions specifying whether each connected tool runs immediately or requires human approval. It does not grant access.
_Avoid_: Access policy, allowlist

**Catalog**:
The complete set of integrations, connections, and tools known to the gateway, independent of a client's access profile.
_Avoid_: Effective tools

**Effective tool**:
A catalogued tool granted by a client's access profile and decorated with the decision from its approval policy.
_Avoid_: Catalog tool

**Default decision**:
The initial approval decision derived from a tool's source: read-only tools run immediately, while other tools require approval.
_Avoid_: Access default
