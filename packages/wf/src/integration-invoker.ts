import { Schema } from "effect"

type JsonValue = typeof Schema.Json.Type

/** Provider-neutral port implemented by an integration host at composition. */
export interface IntegrationInvoker {
  readonly invoke: (address: string, input: JsonValue) => Promise<JsonValue>
}
