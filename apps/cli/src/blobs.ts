import { createWriteStream, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import type { GatewayClient } from "@mokronos/integrations-client"
import { Effect, Schema, Stream } from "effect"
import {
  BlobHandle,
  blobHandleKey,
  localFileKey,
  LocalFileRef,
  type Json
} from "@mokronos/integrations-contracts"
import { integrationsHome } from "@mokronos/integrations-contracts/gateway-config"
import { cliError, describeError, type IntegrationsCliError } from "./connection.ts"

const decodeHandle = Schema.decodeUnknownOption(BlobHandle)
const decodeLocalFile = Schema.decodeUnknownOption(LocalFileRef)
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

const contentTypes = new Map([
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".txt", "text/plain"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".zip", "application/zip"]
])

const contentTypeFor = (extension: string): string =>
  contentTypes.get(extension) ?? "application/octet-stream"

const uploadFile = Effect.fn("cli.uploadFile")(function*(
  client: GatewayClient,
  file: string
) {
  const resolved = path.resolve(file)
  const bytes = yield* Effect.try({
    try: () => new Uint8Array(readFileSync(resolved)),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    catch: (cause: unknown) => cliError(describeError(cause))
  })
  const extension = path.extname(resolved).toLowerCase()
  return yield* client.delegated.uploadBlob({
    headers: {
      "x-blob-content-type": contentTypeFor(extension),
      "x-blob-filename": path.basename(resolved)
    },
    payload: bytes
  })
})

/**
 * Local paths an agent wrote into the arguments are uploaded first, so the
 * gateway streams real bytes into the request instead of a JSON string.
 */
export const resolveFileArguments = (
  client: GatewayClient,
  arguments_: Json
): Effect.Effect<Json, IntegrationsCliError> => {
  const visit = (value: Json): Effect.Effect<Json, IntegrationsCliError> => {
    if (Array.isArray(value)) return Effect.forEach(value, visit)

    const record = decodeRecord(value)
    if (record._tag === "None") return Effect.succeed(value)

    const local = decodeLocalFile(record.value)
    if (local._tag === "Some") {
      return uploadFile(client, local.value[localFileKey]).pipe(
        Effect.map((uploaded): Json => ({ [blobHandleKey]: uploaded[blobHandleKey] })),
        Effect.mapError((cause) => cliError(describeError(cause)))
      )
    }

    return Effect.map(
      Effect.forEach(Object.entries(record.value), ([key, nested]) =>
        Effect.map(visit(nested), (decoded) => [key, decoded] as const)),
      (entries) => Object.fromEntries(entries)
    )
  }
  return visit(arguments_)
}

const downloadDirectory = () => path.join(integrationsHome(), "downloads")

const destinationFor = (handle: BlobHandle, out: string | undefined): string => {
  if (out !== undefined) return path.resolve(out)
  const id = handle[blobHandleKey]
  const name = handle.filename === undefined ? id : `${id}-${handle.filename}`
  return path.join(downloadDirectory(), name)
}

const fetchBlob = Effect.fn("cli.fetchBlob")(function*(
  client: GatewayClient,
  handle: BlobHandle,
  destination: string
) {
  const content = yield* client.delegated.blob({
    params: { id: handle[blobHandleKey] }
  })
  yield* Effect.try({
    try: () => mkdirSync(path.dirname(destination), { recursive: true }),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    catch: (cause: unknown) => cliError(describeError(cause))
  })
  const file = createWriteStream(destination)
  yield* Stream.runForEach(content, (chunk: Uint8Array) =>
    Effect.callback<void>((resume) => {
      file.write(chunk, () => resume(Effect.void))
    })).pipe(
      Effect.ensuring(Effect.callback<void>((resume) => {
        file.end(() => resume(Effect.void))
      }))
    )
  return destination
})

/**
 * Blob handles can arrive nested — an MCP content array carries one per item —
 * so the whole result is walked rather than only its root.
 */
export const materializeBlobs = (
  client: GatewayClient,
  result: Json,
  out: string | undefined
): Effect.Effect<Json, IntegrationsCliError> => {
  const visit = (value: Json): Effect.Effect<Json, IntegrationsCliError> => {
    if (Array.isArray(value)) {
      return Effect.map(Effect.forEach(value, visit), (items) => items)
    }

    const record = decodeRecord(value)
    if (record._tag === "None") return Effect.succeed(value)

    const handle = decodeHandle(record.value)
    if (handle._tag === "Some") {
      const destination = destinationFor(handle.value, out)
      return fetchBlob(client, handle.value, destination).pipe(
        Effect.map((written): Json => ({ ...record.value, path: written })),
        Effect.mapError((cause) => cliError(describeError(cause)))
      )
    }

    return Effect.map(
      Effect.forEach(Object.entries(record.value), ([key, nested]) =>
        Effect.map(visit(nested), (decoded) => [key, decoded] as const)),
      (entries) => Object.fromEntries(entries)
    )
  }
  return visit(result)
}
