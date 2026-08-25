import { Effect, Option, Redacted, Schema } from "effect"
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli"
import { whenPresent } from "@mokronos/contracts"
import { cliError, describeError } from "./connection.ts"
import { jsonOutput, writeStdoutLine } from "./output.ts"
import {
  connectToControlPlane,
  loginOperator,
  loginOperatorInBrowser,
  logoutOperator,
  readOperatorSession,
  signupOperator
} from "./session.ts"

const passwordFlag = () =>
  Flag.redacted("password").pipe(
    Flag.optional,
    Flag.withDescription("Password. Omit to enter it without terminal echo")
  )

const password = (
  provided: Option.Option<Redacted.Redacted<string>>,
  message = "Password"
) =>
  Option.match(provided, {
    onNone: () => Prompt.run(Prompt.password({ message })).pipe(Effect.map(Redacted.value)),
    onSome: (value) => Effect.succeed(Redacted.value(value))
  })

const authTask = <A>(task: () => Promise<A>): Effect.Effect<A, ReturnType<typeof cliError>> =>
  Effect.tryPromise({
    try: task,
    catch: (cause) => cliError(describeError(cause))
  })

const controlPlaneTask = (
  task: (client: Awaited<ReturnType<typeof connectToControlPlane>>) =>
    Promise<typeof Schema.Json.Type>
) => authTask(async () => await task(await connectToControlPlane()))

export const loginCommand = Command.make(
  "login",
  {
    email: Argument.string("email").pipe(Argument.optional),
    password: passwordFlag(),
    noOpen: Flag.boolean("no-open").pipe(
      Flag.withDescription("Print the sign-in URL instead of opening a browser")
    ),
    timeout: Flag.integer("timeout").pipe(
      Flag.withDefault(300),
      Flag.withDescription("Seconds to wait for browser sign-in")
    )
  },
  ({ email, password: provided, noOpen, timeout }) =>
    Effect.gen(function* () {
      const explicitEmail = Option.getOrUndefined(email)
      const session = explicitEmail === undefined
        ? yield* authTask(() => loginOperatorInBrowser({
          noOpen,
          timeoutSeconds: timeout,
          onAuthorization: async (url) => await new Promise<void>((resolve, reject) => {
            process.stdout.write(
              `${noOpen ? "Open" : "If the browser does not open, visit"}: ${url}\n`,
              (error) => error === null || error === undefined ? resolve() : reject(error)
            )
          })
        }))
        : yield* Effect.gen(function* () {
          const secret = yield* password(provided)
          return yield* authTask(() => loginOperator({ email: explicitEmail, password: secret }))
        })
      yield* writeStdoutLine(jsonOutput({ authenticated: true, email: session.email }, false))
    })
).pipe(
  Command.withAlias("auth"),
  Command.withDescription(
    "Sign in through the browser, or pass an email to use a password"
  )
)

export const signupCommand = Command.make(
  "signup",
  {
    email: Argument.string("email"),
    password: passwordFlag(),
    tenant: Flag.string("tenant").pipe(
      Flag.optional,
      Flag.withDescription("Tenant name for a newly claimed gateway")
    )
  },
  ({ email, password: provided, tenant }) =>
    Effect.gen(function* () {
      const secret = yield* password(provided, "Choose a password")
      const session = yield* authTask(() => signupOperator({
        email,
        password: secret,
        ...whenPresent("tenantName", Option.getOrUndefined(tenant))
      }))
      yield* writeStdoutLine(jsonOutput({ authenticated: true, email: session.email }, false))
    })
).pipe(Command.withDescription("Claim an unconfigured gateway and sign in"))

export const logoutCommand = Command.make(
  "logout",
  {},
  () => authTask(logoutOperator).pipe(
    Effect.flatMap(() => writeStdoutLine(jsonOutput({ authenticated: false }, false)))
  )
).pipe(Command.withDescription("Revoke and forget the saved human session"))

export const whoamiCommand = Command.make(
  "whoami",
  {},
  () => authTask(async () => {
    const saved = await readOperatorSession()
    if (saved === undefined) return { authenticated: false }
    const client = await connectToControlPlane()
    return Schema.decodeUnknownSync(Schema.Json)(await client.request("GET", "/v1/auth/me"))
  }).pipe(Effect.flatMap((result) => writeStdoutLine(jsonOutput(result, false))))
).pipe(Command.withDescription("Show the human identity saved for ii"))

const changeEmailCommand = Command.make(
  "email",
  {
    email: Argument.string("new-email"),
    password: passwordFlag()
  },
  ({ email, password: provided }) =>
    Effect.gen(function* () {
      const secret = yield* password(provided, "Current password")
      const result = yield* controlPlaneTask((client) =>
        client.request("POST", "/v1/auth/email", { email, password: secret })
      )
      yield* writeStdoutLine(jsonOutput(result, false))
    })
).pipe(Command.withDescription("Change the signed-in human's email address"))

const changePasswordCommand = Command.make(
  "password",
  {
    current: Flag.redacted("current").pipe(
      Flag.optional,
      Flag.withDescription("Current password. Omit to enter it without terminal echo")
    ),
    next: Flag.redacted("new").pipe(
      Flag.optional,
      Flag.withDescription("New password. Omit to enter it without terminal echo")
    ),
    initial: Flag.boolean("initial").pipe(
      Flag.withDescription("Set the first password on an OAuth-only account")
    )
  },
  ({ current, next, initial }) =>
    Effect.gen(function* () {
      const currentPassword = initial
        ? undefined
        : yield* password(current, "Current password")
      const newPassword = yield* password(next, "New password")
      const result = yield* controlPlaneTask((client) =>
        client.request("POST", "/v1/auth/password", {
          ...whenPresent("currentPassword", currentPassword),
          newPassword
        })
      )
      yield* writeStdoutLine(jsonOutput(result, false))
    })
).pipe(Command.withDescription("Change the signed-in human's password"))

const deleteAccountCommand = Command.make(
  "delete",
  {
    password: passwordFlag(),
    yes: Flag.boolean("yes").pipe(
      Flag.withDescription("Confirm permanent deletion of this human account")
    )
  },
  ({ password: provided, yes }) => {
    if (!yes) {
      return Effect.fail(cliError("Account deletion requires --yes"))
    }
    return Effect.gen(function* () {
      const secret = yield* password(provided, "Current password")
      const result = yield* controlPlaneTask((client) =>
        client.request("POST", "/v1/auth/account/delete", { password: secret })
      )
      yield* authTask(async () => {
        await logoutOperator()
      })
      yield* writeStdoutLine(jsonOutput(result, false))
    })
  }
).pipe(Command.withDescription("Permanently delete the signed-in human account"))

export const accountCommand = Command.make("account").pipe(
  Command.withDescription("Manage the signed-in human account"),
  Command.withSubcommands([
    changeEmailCommand,
    changePasswordCommand,
    deleteAccountCommand
  ])
)

export const authenticationSubcommands = [
  loginCommand,
  signupCommand,
  logoutCommand,
  whoamiCommand,
  accountCommand
] as const
