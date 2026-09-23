import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { integrationsHome } from "@mokronos/integrations-client"
import { traceFilePath } from "@mokronos/integrations-contracts/gateway-config"
import { telemetryLayer } from "@mokronos/integrations-observability"
import packageMetadata from "../package.json" with { type: "json" }

/** Platform services plus telemetry: stdout stays the command's, spans land in the CLI trace file. */
export const cliLayer = (serviceName: string) =>
  telemetryLayer({
    serviceName,
    serviceVersion: packageMetadata.version,
    console: "stderr",
    traceFile: traceFilePath(integrationsHome(), "cli")
  }).pipe(Layer.provideMerge(BunServices.layer))

/** Names the invocation by its subcommands only; flag values can carry secrets. */
export const commandSpan = (argv: ReadonlyArray<string>) =>
  Effect.withSpan("Cli.command", {
    attributes: {
      "cli.command": argv.filter((argument) => !argument.startsWith("-")).slice(0, 2).join(" ")
    }
  })
