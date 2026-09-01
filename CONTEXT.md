# Integration Gateway

The gateway delegates access to external tools without exposing credentials to agent runtimes.

## Language

**Client**:
A distinct runtime identity, such as one agent sandbox or deployment, authenticated by one or more API keys.
_Avoid_: Agent, API key

**Access profile**:
A reusable, tenant-owned configuration of enabled tools on named connections. Exactly one access profile is assigned to each client.
_Avoid_: Grant, binding

**Approval policy**:
A reusable, tenant-owned configuration of approval decisions for tools on named connections. Exactly one approval policy is assigned to each client.
_Avoid_: Permission set

**Access-profile tool**:
One enabled tool on one connection in an access profile. A connection belongs to the profile exactly when it has an enabled tool.
_Avoid_: Tool grant

**Approval-policy tool**:
One approval decision for a tool on one connection in an approval policy.
_Avoid_: Policy rule

**Effective tool**:
A tool enabled by the client's access profile and governed by its approval policy.
_Avoid_: Granted tool

**Approval**:
A human decision about one frozen invocation with one exact set of arguments. It never creates standing authority.

**Connection**:
Stored authorization for one external integration account or installation.
_Avoid_: Client, policy
