import { fileURLToPath } from "node:url"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Output from "alchemy/Output"
import { Random } from "alchemy"
import { Stage } from "alchemy/Stage"
import { whenPresent } from "@integragents/contracts"
import { gatewayRoutes } from "@integragents/gateway-api"
import { Array as Arr, Config, Effect, Encoding, Option, Redacted, Result } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { Gateway } from "./gateway.ts"

const dashboard = Effect.suspend(() =>
  Command.Build("Dashboard", {
    cwd: fileURLToPath(new URL("../../web", import.meta.url)),
    command: "bun run --cwd ../.. build && bun run build",
    outdir: "dist",
    memo: { include: ["**/*", "../../packages/*/src/**", "../../packages/core/*/src/**"], lockfile: true }
  })
)

/** The key sealing everything at rest: minted once per stage and kept in that stage's state. */
const masterKey = Random("MasterKey", { bytes: 32 }).pipe(
  Effect.map((random) =>
    random.text.pipe(Output.map((hex) =>
      Redacted.make(Encoding.encodeBase64Url(Result.getOrThrow(Encoding.decodeHex(Redacted.value(hex)))))
    ))
  )
)

/** Deployed stages keep the Worker names their public URLs, and the OAuth redirects registered against them, were issued under. */
const workerNames = new Map([
  ["prod", "integrations-gateway"],
  ["staging", "integrations-gateway-staging"]
])

/** Settings the deployer may supply; each is bound only when set to something in the deploying environment. */
const passThrough = <A>(names: ReadonlyArray<string>, bind: (value: string) => A) =>
  Effect.forEach(names, (name) =>
    Config.String(name).pipe(
      Config.option,
      Effect.map(Option.filter((value) => value !== "")),
      Effect.map(Option.map((value) => [name, bind(value)] as const))
    )).pipe(Effect.map((found) => Object.fromEntries(Arr.getSomes(found))))

export class GatewayWorker extends Cloudflare.Worker<GatewayWorker, {}>()("Gateway") {}

export default GatewayWorker.make(
  Effect.gen(function*() {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
    const site = yield* dashboard
    return {
      main: import.meta.url,
      ...whenPresent("name", workerNames.get(yield* Stage)),
      compatibility: { date: "2026-09-08" },
      assets: {
        directory: site.outdir,
        notFoundHandling: "single-page-application" as const,
        runWorkerFirst: [...gatewayRoutes]
      },
      observability: { enabled: true },
      env: {
        INTEGRATIONS_MASTER_KEY: yield* masterKey,
        INTEGRATIONS_PUBLIC_URL: Cloudflare.Worker.URL,
        INTEGRATIONS_ALLOW_SIGNUP: "1",
        ...yield* passThrough([
          "INTEGRATIONS_GOOGLE_CLIENT_ID",
          "OTEL_EXPORTER_OTLP_ENDPOINT",
          "OTEL_TRACES_EXPORTER",
          "OTEL_LOGS_EXPORTER"
        ], (value) => value),
        ...yield* passThrough(["INTEGRATIONS_GOOGLE_CLIENT_SECRET", "OTEL_EXPORTER_OTLP_HEADERS"], Redacted.make)
      }
    }
  }),
  Effect.gen(function*() {
    const gateways = yield* Gateway
    const gateway = () => gateways.getByName("gateway")
    yield* Cloudflare.Workers.cron("*/5 * * * *", () =>
      gateway().maintain().pipe(Effect.tapCause((cause) => Effect.logError("Scheduled maintenance failed", cause))))
    return {
      fetch: Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => gateway().fetch(request))
    }
  }).pipe(Effect.provide(Cloudflare.Workers.CronEventSourceLive))
)
