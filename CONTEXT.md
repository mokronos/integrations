# Integration Gateway

The gateway delegates access to external tools without exposing credentials to agent runtimes.

## Language

**Client**:
A distinct runtime identity, such as one agent sandbox or deployment, authenticated by one or more API keys.
_Avoid_: Agent, API key

**Policy**:
A reusable, tenant-owned configuration of integration memberships and explicit tool states. Exactly one policy is assigned to each client.
_Avoid_: Grant, permission set

**Policy integration**:
An integration explicitly added to a policy. Its absence means the integration is not part of that policy.

**Policy tool**:
A tool under a policy integration, with an explicit enabled state and approval decision. Disabled tools remain in the policy.
_Avoid_: Tool grant

**Client tool binding**:
A client-specific route from an alias and tool name to the connection whose credentials perform the call.
_Avoid_: Grant, policy rule

**Effective tool**:
An enabled tool whose integration is in the client's assigned policy and which has a client tool binding.
_Avoid_: Granted tool

**Approval**:
A human decision about one frozen invocation with one exact set of arguments. It never creates standing authority.

**Connection**:
Stored authorization for one external integration account or installation.
_Avoid_: Client, policy
