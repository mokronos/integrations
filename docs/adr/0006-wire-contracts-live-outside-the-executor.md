# Wire contracts live outside the Executor

Gateway request and response shapes live in the dependency-light
`@mokronos/integrations-protocol` package as Effect Schemas. The Executor and
client consume the same schemas, while the protocol package performs no
discovery, storage, authorization, or execution; this prevents the sandbox
client from acquiring the Executor's runtime dependency graph merely to decode
gateway responses. Executor keeps re-exporting these schemas so its existing
domain-facing imports remain source-compatible.
