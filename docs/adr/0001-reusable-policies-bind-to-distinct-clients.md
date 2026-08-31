# Reusable policies bind to distinct clients

Each client has exactly one reusable tenant policy, while aliases and credential-bearing connection bindings remain client-specific. We rejected per-client/per-tool grants because they made shared agent roles expensive to manage, and rejected shared clients because they collapse audit attribution, revocation boundaries, and compromise isolation; authorization is therefore the intersection of a client's assigned policy and its own bindings.
