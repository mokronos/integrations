# Integration Gateway

The gateway delegates access to external tools without exposing credentials to agent runtimes.

## Language

**Client**:
A distinct runtime identity, such as one agent sandbox or deployment, authenticated by one or more API keys.
_Avoid_: Agent, API key

**Policy**:
A reusable, tenant-owned configuration of integration memberships and explicit tool states. Exactly one policy is assigned to each client.
_Avoid_: Grant, permission set

**Policy tool**:
A rule under a policy for one tool on one connection, with an explicit enabled state and approval decision. A rule is what puts a connection in the policy; disabled rules remain.
_Avoid_: Tool grant, policy integration

**Connection grant**:
One client's reach to one connection, and the alias that client calls it by. The alias is chosen when the grant is made and never recomputed.
_Avoid_: Binding, policy rule

**Effective tool**:
A tool on a connection the client holds a grant for, enabled by a rule in the client's assigned policy. A rule for a connection the client was not granted contributes nothing and is not an error.
_Avoid_: Granted tool

**Approval**:
A human decision about one frozen invocation with one exact set of arguments. It never creates standing authority.

**Connection**:
Stored authorization for one external integration account or installation.
_Avoid_: Client, policy
