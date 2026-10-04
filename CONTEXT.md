# Integrations Gateway

The integrations gateway connects external tool providers to agents. Each profile says which tools its apps may call and which calls wait for a human.

## Language

**Profile**:
What a set of AI apps may do through the gateway: its enabled tools, whether each one asks first, its saved approvals, and how approvals reach a human. Several apps (Claude Code, ChatGPT, Gemini CLI) share one profile by each connecting with their own key or OAuth grant. A profile is never shared by reference: copying one creates an independent profile.
_Avoid_: Client, access profile, approval policy

**Profile tool**:
One enabled tool on one connection, with its decision. A tool that is off has no row.
_Avoid_: Grant, policy rule

**Decision**:
Whether an enabled tool runs immediately (`allow`, shown as Allow) or waits for a human (`require_approval`, shown as Ask).
_Avoid_: Policy

**Default decision**:
The decision a tool starts with, derived from its source: read-only tools run immediately, the rest ask.
_Avoid_: Access default

**API key**:
One app's credential for a profile, named after the app that uses it. Revoking it cuts off that app alone.
_Avoid_: Client key

**OAuth application**:
An external MCP program that requests delegated access to the gateway.
_Avoid_: Client, Gateway Client

**OAuth grant**:
A person's revocable authorization for an OAuth application to act as a particular profile.
_Avoid_: Login session, API key

**Caller**:
What a call is attributed to: the API key or OAuth application it arrived with, and the agent it reported, such as an MCP client's name.
_Avoid_: Client

**Saved approval**:
An "always approve" rule on one profile tool: later calls whose arguments fit its pattern run without asking. It belongs to the profile that saved it.
_Avoid_: Approval rule, allowlist

**Catalog**:
The complete set of integrations, connections, and tools known to the gateway, independent of any profile.
_Avoid_: Effective tools

**Effective tool**:
A catalogued tool a profile enables, with its decision.
_Avoid_: Catalog tool
