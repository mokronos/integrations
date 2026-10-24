import { DateTime, Duration, Effect, Option } from "effect"
import { Command, Flag } from "effect/cli"
import { forgetAgentLogin, loginToGateway, savedLoginIdentity, savedLoginUrl } from "../agent-credentials.ts"
import { gatewayTask } from "../tasks.ts"
import { jsonOutput, writeStdoutLine } from "../output.ts"
import { resolveGatewayUrl } from "../session.ts"

const pendingOutput = (pending: {
  readonly userCode: string
  readonly verificationUri: string
  readonly expiresAt: number
}) =>
  jsonOutput(
    {
      status: "pending",
      code: pending.userCode,
      url: pending.verificationUri,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(pending.expiresAt)),
      next: `Ask your user to open ${pending.verificationUri}, check the code ${pending.userCode} and approve it for a profile. Then run \`i login\` again.`
    },
    false
  )

export const agentLoginCommand = Command.make(
  "login",
  {
    url: Flag.String("url").pipe(
      Flag.optional,
      Flag.withDescription(
        "The gateway to log in to. Defaults to the last login, INTEGRATIONS_URL, or the local gateway"
      )
    ),
    wait: Flag.Boolean("wait").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Keep waiting until the code is approved or expires, instead of checking once")
    )
  },
  ({ url, wait }) =>
    Effect.gen(function* () {
      const gateway = Option.isSome(url) ? url.value : ((yield* savedLoginUrl) ?? (yield* resolveGatewayUrl()))
      const current = yield* savedLoginIdentity(gateway)
      if (Option.isSome(current)) {
        return yield* writeStdoutLine(
          jsonOutput(
            {
              status: "authenticated",
              gateway,
              profile: current.value.profile.name,
              next: "Already logged in. To use another profile, run `i logout` first."
            },
            false
          )
        )
      }
      const result = yield* loginToGateway({
        url: gateway,
        wait: wait ? Option.some(Duration.minutes(10)) : Option.none(),
        onPending: (pending) => writeStdoutLine(pendingOutput(pending))
      })
      if (result.status === "pending") {
        if (!wait) yield* writeStdoutLine(pendingOutput(result.pending))
        return
      }
      yield* writeStdoutLine(
        jsonOutput(
          {
            status: "authenticated",
            gateway: result.url,
            next: "Run `i integrations` to see what you can use."
          },
          false
        )
      )
    })
).pipe(
  Command.withDescription(
    "Log in to a gateway: shows a code your user approves in the dashboard. Run it again to finish"
  )
)

export const agentLogoutCommand = Command.make("logout", {}, () =>
  forgetAgentLogin().pipe(
    Effect.flatMap(() =>
      writeStdoutLine(
        jsonOutput(
          {
            status: "logged-out",
            next: "This machine forgot its login. Your user can also revoke it on the profile's page in the dashboard."
          },
          false
        )
      )
    )
  )
).pipe(Command.withDescription("Forget the login `i login` saved"))

export const whoamiCommand = Command.make("whoami", {}, () =>
  gatewayTask((client) =>
    Effect.map(client.delegated.whoami(), (identity) => ({ gateway: client.url, ...identity }))
  ).pipe(Effect.flatMap((identity) => writeStdoutLine(jsonOutput(identity, false))))
).pipe(
  Command.withDescription(
    "Show which gateway `i` reaches and as whom: the profile, the key or login, and the person it acts for"
  )
)
