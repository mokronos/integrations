import { Schema } from "effect"
import { HttpApiSchema } from "effect/http-api"
import { Alias, ConnectionRef, ToolDecision } from "@integragents/contracts"

export const Json = Schema.Json

export const EffectiveTool = Schema.Struct({
  alias: Alias,
  tool: Schema.String,
  connection: ConnectionRef,
  decision: ToolDecision,
  delegated: Schema.Boolean,
  readOnly: Schema.optional(Schema.Boolean),
  destructive: Schema.optional(Schema.Boolean),
  idempotent: Schema.optional(Schema.Boolean),
  description: Schema.optional(Schema.String),
  inputSchema: Schema.optional(Json),
  outputSchema: Schema.optional(Json)
})

export class ApiBadRequest extends Schema.TaggedError<ApiBadRequest>()("ApiBadRequest", { error: Schema.String }) {}
export const ApiBadRequestError = ApiBadRequest.pipe(HttpApiSchema.status(400))

export class ApiNotFound extends Schema.TaggedError<ApiNotFound>()("ApiNotFound", { error: Schema.String }) {}
export const ApiNotFoundError = ApiNotFound.pipe(HttpApiSchema.status(404))
