import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import {
  AppContext,
  AppSession,
  AppSessionId,
  AppSessionNotes,
  Forbidden,
  IntegrationError,
  NotFound,
  ResourceContents
} from "@integragents/contracts"
import { Authority } from "../middleware.ts"
import { RequiredAccess } from "../identity.ts"
import { Json } from "./shared.ts"

/**
 * The dashboard hosts a tool's MCP App for a person: it reads the session,
 * relays the calls and reads the view makes, and keeps what the view tells
 * the agent. The agent's key reads those notes back and nothing else.
 */
export const AppsGroup = HttpApiGroup.make("apps")
  .add(
    HttpApiEndpoint.get("appSession", "/v1/app-sessions/:id", {
      params: { id: AppSessionId },
      success: AppSession,
      error: NotFound
    }).annotate(RequiredAccess, "human")
  )
  .add(
    HttpApiEndpoint.post("callFromApp", "/v1/app-sessions/:id/call", {
      params: { id: AppSessionId },
      payload: Schema.Struct({ name: Schema.String, arguments: Schema.optional(Schema.Record(Schema.String, Json)) }),
      success: Json,
      error: [NotFound, Forbidden]
    }).annotate(RequiredAccess, "human")
  )
  .add(
    HttpApiEndpoint.post("readFromApp", "/v1/app-sessions/:id/read", {
      params: { id: AppSessionId },
      payload: Schema.Struct({ uri: Schema.String }),
      success: Schema.Struct({ contents: Schema.Array(ResourceContents) }),
      error: IntegrationError.members
    }).annotate(RequiredAccess, "human")
  )
  .add(
    HttpApiEndpoint.put("appContext", "/v1/app-sessions/:id/context", {
      params: { id: AppSessionId },
      payload: AppContext,
      success: Schema.Struct({}),
      error: NotFound
    }).annotate(RequiredAccess, "human")
  )
  .add(
    HttpApiEndpoint.post("appMessage", "/v1/app-sessions/:id/messages", {
      params: { id: AppSessionId },
      payload: Schema.Struct({ content: Schema.Array(Json) }),
      success: Schema.Struct({}),
      error: NotFound
    }).annotate(RequiredAccess, "human")
  )
  .add(
    HttpApiEndpoint.get("appNotes", "/v1/app-sessions/:id/notes", {
      params: { id: AppSessionId },
      success: AppSessionNotes,
      error: NotFound
    }).annotate(RequiredAccess, "delegated")
  )
  .middleware(Authority)
