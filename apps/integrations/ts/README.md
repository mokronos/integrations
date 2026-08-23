# @mokronos/integrations-client

TypeScript client for a gateway's delegated API. It resolves a gateway
connection, sends authenticated requests, and decodes the response; connection
selection and authorization remain in the gateway.

All public request and response contracts are exported Effect Schemas with
types derived from those schemas. Responses are decoded at the HTTP boundary;
methods never return an unvalidated generic JSON object.

Use the [Gateway client documentation](../../../docs/client.md) for
installation, API reference, and generated bindings.
