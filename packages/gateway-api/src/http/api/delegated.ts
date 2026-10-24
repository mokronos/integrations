import { IntegrationError, NotFound, ResourceContents, ResourceEntry, SkillEntry } from "@integragents/contracts"
import { Effect, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import {
  ApprovalId,
  BlobId,
  BlobUpload,
  CredentialIdentity,
  IdempotencyKey,
  PendingApproval
} from "@integragents/contracts"
import {
  Alias,
  BooleanFromString,
  ConnectionName,
  IntegrationSlug,
  InvocationSucceeded,
  InvocationPending,
  InvocationDenied,
  InvocationFailed,
  InvocationInputRequired,
  InvocationInvalid,
  InvocationAuthorizationRequired
} from "@integragents/contracts"
import { Authority } from "../middleware.ts"
import { RequiredAccess } from "../identity.ts"
import { EffectiveTool, Json } from "./shared.ts"

const WireAlias = Alias

const ExecuteBody = Schema.Struct({
  alias: WireAlias,
  tool: Schema.String,
  arguments: Schema.optional(Json),
  /**
   * The caller's name for this call, the same on every retry: a repeat gets
   * the first call's outcome, or waits on its approval, instead of running
   * again, and is refused when it names another tool or other arguments.
   */
  idempotencyKey: Schema.optional(IdempotencyKey)
})

const InvokedOk = Schema.Union([
  InvocationSucceeded,
  InvocationPending,
  InvocationAuthorizationRequired,
  InvocationInputRequired
])

const InvokedDenied = InvocationDenied.pipe(HttpApiSchema.status(403))
const InvokedFailed = InvocationFailed.pipe(HttpApiSchema.status(502))
const InvokedInvalid = InvocationInvalid.pipe(HttpApiSchema.status(400))

export const DelegatedGroup = HttpApiGroup.make("delegated")
  .add(
    HttpApiEndpoint.get("whoami", "/v1/whoami", { success: CredentialIdentity }).annotate(RequiredAccess, "delegated")
  )
  .add(
    HttpApiEndpoint.get("listTools", "/v1/tools", {
      query: {
        schemas: BooleanFromString.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))),
        integration: Schema.optional(IntegrationSlug),
        connection: Schema.optional(ConnectionName)
      },
      success: Schema.Struct({ tools: Schema.Array(EffectiveTool) })
    }).annotate(RequiredAccess, "delegated")
  )
  .add(
    HttpApiEndpoint.post("execute", "/v1/execute", {
      payload: ExecuteBody,
      success: [InvokedOk, InvokedDenied, InvokedFailed, InvokedInvalid]
    }).annotate(RequiredAccess, "delegated")
  )
  .add(
    HttpApiEndpoint.get("approval", "/v1/approvals/:id", {
      params: { id: ApprovalId },
      success: PendingApproval,
      error: NotFound
    }).annotate(RequiredAccess, "delegated")
  )
  .add(
    HttpApiEndpoint.get("listResources", "/v1/resources", {
      success: Schema.Struct({ resources: Schema.Array(ResourceEntry) }),
      error: IntegrationError.members
    }).annotate(RequiredAccess, "delegated")
  )
  .add(
    HttpApiEndpoint.get("readResource", "/v1/resources/read", {
      query: { uri: Schema.String },
      success: Schema.Struct({ contents: Schema.Array(ResourceContents) }),
      error: IntegrationError.members
    }).annotate(RequiredAccess, "delegated")
  )
  .add(
    HttpApiEndpoint.get("listSkills", "/v1/skills", {
      success: Schema.Struct({ skills: Schema.Array(SkillEntry) }),
      error: IntegrationError.members
    }).annotate(RequiredAccess, "delegated")
  )
  .add(
    HttpApiEndpoint.get("blob", "/v1/blobs/:id", {
      params: { id: BlobId },
      success: HttpApiSchema.StreamUint8Array(),
      error: NotFound
    }).annotate(RequiredAccess, "delegated")
  )
  .add(
    HttpApiEndpoint.post("uploadBlob", "/v1/blobs", {
      headers: {
        "x-blob-content-type": Schema.optional(Schema.String),
        "x-blob-filename": Schema.optional(Schema.String)
      },
      payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      success: BlobUpload
    }).annotate(RequiredAccess, "delegated")
  )
  .middleware(Authority)
