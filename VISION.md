# Integrations Vision

An integration is defined by a URL that leads to some sort of API.

- actions
  - name
  - description
  - input schema
  - output schema

## Auth

- OAuth
- bearer

## Gateway

- client
  - search integrations
  - discover integration auth and schemas
  - trigger auth
  - list actions
  - execute action

```text
agent harness -> sandbox -> client -> API-key-injecting proxy -> gateway -> integration
                                                              -> human
```

When human in the loop happens in the gateway, for example when a tool needs to
POST to Gmail to write an email, the gateway returns an input-required or
approval-required response. Per client, the gateway should support:

- sending an approval link back to the original client
- sending approval notifications to a phone or webhook
- showing the approval in the gateway dashboard

The model must not be able to approve its own request. A surrounding application
may expose the approval link to its user, but the sandbox must be unable to call
the approval endpoint. The invocation therefore needs an execution identifier
that lets the client resume or collect the result after a decision.

Applications with their own human-in-the-loop UI can handle approval-required
responses in the proxy surrounding the sandbox. That proxy already selects the
gateway and injects the client's API key.

The gateway should let each client configure one or more approval delivery
mechanisms. A client can handle the request outside the sandbox or return a safe
approval link for the model to present to the user.

By default, mutating requests should require approval while read requests are
allowed. The gateway UI should allow changing that policy per tool or per
integration for each client.

Clients may include:

- a CLI
- a TypeScript library
- a Python library
- an MCP server exposing the same gateway capabilities

These clients are peers in the architecture: each is a way to consume the same
gateway API.
