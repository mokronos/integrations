# Human OAuth and CLI browser handoff share gateway sessions

Dashboard humans may authenticate with a password or Google OpenID Connect,
while `ii login` starts the same Google flow in a browser and collects a
short-lived, one-use handoff for a normal gateway session. Human identity OAuth
is kept separate from integration OAuth: the former proves who may operate the
control plane, while the latter authorizes tools to act on an external system.

## Consequences

- The gateway stores external provider subjects beside its own opaque subjects;
  provider tokens are used only to resolve identity and are not retained.
- CLI handoff secrets and OAuth state are stored only as hashes, expire after
  ten minutes, and can be collected once.
- Dashboard redirects accept only same-origin paths, and approval destinations
  still pass through the ordinary human authentication gate.
- OAuth-only accounts may add a password, but destructive account deletion
  requires that password rather than treating possession of a session as fresh
  reauthentication.
