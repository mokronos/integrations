# Client identity binds at deployment, not authoring

A workflow definition names the tools it needs by **alias** and carries no API
key, no connection, and no subject; the key is supplied by whatever runs it.
Two people running the same definition on two machines therefore use two keys,
two sets of grants, and their own connections, with nothing in the definition
changing. An alias is a declared requirement bound per deployment — the same
relationship a program has with an environment variable — which is what keeps
one definition portable across people while still naming *which* SharePoint it
means.

## Consequences

- The multi-user case needs no per-run subject binding. Identity varies by key,
  and a key belongs to a deployment, so the harder design where one runner
  serves many users with one client does not arise.
- Validation gains teeth for free. The existing requirement extraction already
  walks a traced workflow; against a configured key it now answers "your key has
  no grant aliased `sharepoint-app`", which is a better failure than the
  ambiguous-resolution error it replaces.
- Aliases are chosen while authoring, not read out of the catalog. The catalog
  is consulted to *bind* an alias, never to discover what to write into a
  definition.
- Because the alias form replaces the previous portable and address-based source
  shapes, and the durable step name is derived from the source shape, this is a
  breaking change for any suspended run. Taken as a clean break while the only
  durable state was local scratch databases; a later change of this kind would
  need the compatibility variant that was removed here.
