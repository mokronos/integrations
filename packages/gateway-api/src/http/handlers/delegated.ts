import { whenPresent, whenPresentMap } from "@integragents/contracts"
import type { CredentialIdentity } from "@integragents/contracts"
import { BlobStore, Integrations } from "@integragents/integrations"
import { Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { ApprovalId, BlobId, blobHandleKey, NotFound, ToolName } from "@integragents/contracts"
import { invokeAsProfile, listEffectiveTools, reachableBy } from "@integragents/gateway-core"
import { GatewayStoreService } from "@integragents/gateway-core"
import { GatewayApi } from "../api.ts"
import { requireProfileCaller } from "../authority.ts"
import { capture } from "../observability.ts"
import { findProfileApproval, invokeDependencies } from "../operations.ts"
import { listProfileResources, profileConnections, readProfileResource } from "../resources.ts"
import { listProfileSkills } from "../skills.ts"
import { withAppSession } from "../app-sessions.ts"

export const DelegatedLayer = HttpApiBuilder.group(GatewayApi, "delegated", (handlers) =>
  Effect.gen(function* () {
    const store = yield* GatewayStoreService
    const integrations = yield* Integrations
    const blobs = yield* BlobStore
    return handlers
      .handle("whoami", () =>
        Effect.map(requireProfileCaller, ({ profile, origin, subject }): CredentialIdentity => ({
          profile: { id: profile.id, name: profile.name },
          credential: {
            kind: origin.caller.oauthGrantId === null ? "key" : "login",
            name: origin.caller.credentialName ?? profile.name
          },
          subject: subject ?? null
        }))
      )
      .handle("listTools", (request) =>
        Effect.gen(function* () {
          const { profile, subject } = yield* requireProfileCaller
          const tools = yield* capture(
            listEffectiveTools(store, profile.id, {
              schemas: request.query["schemas"],
              integrations,
              ...whenPresentMap("integration", request.query["integration"], (integration) => integration),
              ...whenPresentMap("connection", request.query["connection"], (connection) => connection)
            })
          )
          return { tools: tools.filter(reachableBy(subject)) }
        })
      )
      .handle("execute", (request) =>
        Effect.gen(function* () {
          const { profile, origin, subject } = yield* requireProfileCaller
          const call = {
            alias: request.payload.alias,
            tool: ToolName.make(request.payload.tool),
            arguments: request.payload.arguments ?? {}
          }
          const outcome = yield* capture(
            invokeAsProfile(yield* invokeDependencies, {
              profile,
              origin,
              ...call,
              ...whenPresent("subject", subject),
              ...whenPresent("idempotencyKey", request.payload.idempotencyKey)
            })
          )
          return yield* withAppSession(profile, origin, call, outcome)
        })
      )
      .handle("listResources", () =>
        Effect.gen(function* () {
          const { profile } = yield* requireProfileCaller
          return { resources: yield* listProfileResources(yield* profileConnections(profile)) }
        })
      )
      .handle("readResource", (request) =>
        Effect.gen(function* () {
          const { profile } = yield* requireProfileCaller
          return {
            contents: yield* readProfileResource(yield* profileConnections(profile), request.query["uri"])
          }
        })
      )
      .handle("listSkills", () =>
        Effect.gen(function* () {
          const { profile } = yield* requireProfileCaller
          return { skills: yield* listProfileSkills(yield* profileConnections(profile)) }
        })
      )
      .handle("blob", (request) =>
        Effect.gen(function* () {
          const id = BlobId.make(request.params["id"])
          const opened = yield* blobs.open(id).pipe(Effect.mapError(() => new NotFound({ resource: "blob", id })))
          return opened.content
        })
      )
      .handle("uploadBlob", (request) =>
        Effect.gen(function* () {
          const stored = yield* capture(
            blobs.write(
              {
                contentType: request.headers["x-blob-content-type"] ?? "application/octet-stream",
                filename: request.headers["x-blob-filename"]
              },
              Stream.succeed(request.payload)
            )
          )
          return {
            [blobHandleKey]: stored.id,
            bytes: stored.bytes,
            contentType: stored.contentType,
            sha256: stored.sha256
          }
        })
      )
      .handle("approval", (request) =>
        Effect.gen(function* () {
          const id = ApprovalId.make(request.params["id"])
          const { profile } = yield* requireProfileCaller
          const approval = yield* findProfileApproval(profile, id)
          if (approval === undefined) return yield* new NotFound({ resource: "approval", id })
          return approval
        })
      )
  })
)
