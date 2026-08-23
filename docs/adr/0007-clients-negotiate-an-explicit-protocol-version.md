# Clients negotiate an explicit protocol version

`GET /v1/metadata` returns uncached gateway build metadata and an integer wire-protocol
version. A client checks that unauthenticated endpoint once, before sending any
credentialed request, and rejects an unsupported version with a dedicated
error; package versions may move independently for compatible fixes, while the
protocol integer changes only for an incompatible wire contract.
