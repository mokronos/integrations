# Integrations

External systems a workflow or an agent can act through, and the delegated
authority that lets them. The gateway holds the credentials; callers hold only
what they were granted.

## Language

### Identity and delegation

**Tenant**:
The isolation partition — in practice a company, and a single person is a
tenant of one. An opaque identifier with no properties of its own.
_Avoid_: Org, workspace, account, organization

**Subject**:
A human identity within a tenant. Opaque — no name, email, or roles.
_Avoid_: User, member, account

**Owner tier**:
Which of two partitions a connection is filed under: `org` (shared by the
whole tenant) or `user` (private to one subject). A partition, not an entity.
_Avoid_: Org, scope, level

**Principal**:
An authenticated caller as seen at a network boundary, resolving inward to a
tenant and a subject. The same identity as a subject, viewed from outside.
_Avoid_: Identity, caller, actor

**Client**:
Anything that calls the gateway — an agent, a workflow runner, a script, a
person at a terminal. Has no inherent access and is never a subject.
_Avoid_: Agent, endpoint, consumer, app

**API key**:
The credential a client presents. Identifies the client and nothing else; the
tenant and the humans acted for are derived from the client's grants.
_Avoid_: Token, session token, secret

**Grant**:
A delegation: one client may invoke one tool through one connection. The only
source of a client's access.
_Avoid_: Permission, scope, capability, role

**Alias**:
The logical name a grant exposes a tool under. Declared as a requirement by
the caller and bound to a connection per deployment — an environment variable,
not a pointer.
_Avoid_: Binding, handle, label

### Catalog

**Integration**:
An external system in a tenant's catalog — Gmail, Slack, a GitHub API.
Discovered from a standardised description, never hand-authored.
_Avoid_: Connector, provider, service, app

**Tool**:
A single named operation an integration exposes, carrying its own input and
output schemas. The smallest unit that can be invoked, granted, or approved.
_Avoid_: Action, operation, function, endpoint

**Connection**:
A stored authorization letting a tenant use an integration. Holds references
exchanged for credentials at the moment of use, never credential values.
_Avoid_: Credential, account, link, install

**Connection name**:
The label distinguishing several connections to one integration under one
owner tier — three Google accounts as `personal`, `work`, `client-x`. Chosen
where the credential lives; a client sees aliases instead.
_Avoid_: Alias, key, slug

**Drift**:
A divergence between the catalog's recorded shape of a tool and what the
vendor now exposes — a renamed tool, a changed schema. Detected on refresh.
_Avoid_: Staleness, desync

### Authorization

**Policy**:
A rule producing an authorization decision for an attempted invocation: allow
or require approval. Concerned only with *whether* an invocation may proceed.
_Avoid_: Rule, permission, guard. Never bare "policy" where a retry policy or
concurrency policy could be meant — say "authorization policy".

**Pending approval**:
An invocation frozen awaiting a human decision. On approval the gateway
performs it, so approving discharges one specific invocation and confers no
capability. Expires, and expiry means the invocation does not happen.
_Avoid_: Pending action, approval request, hold

**Audit record**:
What the gateway writes for every invocation attempt: client, alias, resolved
connection, subject acted for, tool, decision, outcome. Retained permanently;
the arguments attached to it are not.
_Avoid_: Log, event, trace

**Gateway**:
The service holding connections and credentials, resolving grants, deciding
policy, and performing invocations. The only component that ever sees a
credential.
_Avoid_: Server, proxy, broker, hub
