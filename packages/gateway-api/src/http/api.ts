import { HttpApi } from "effect/http-api"
import { Authority } from "./middleware.ts"
import { Forbidden, GatewayFailure } from "./identity.ts"
import { AdministrativeGroup } from "./api/administrative.ts"
import {
  AuthGroup,
  HandoffCollected,
  HandoffExpired,
  HandoffUnknown,
  InvalidCredentials,
  PasswordRequired,
  SignupClosed,
  ApiNotImplemented
} from "./api/auth.ts"
import { DelegatedGroup } from "./api/delegated.ts"
import { ApiGone, OAuthGroup } from "./api/oauth.ts"
import { ProvisioningGroup } from "./api/provisioning.ts"
import { ApiBadRequest, ApiNotFound } from "./api/shared.ts"
import { FallbackGroup, SystemGroup } from "./api/system.ts"

export { ChangeEmailBody, ChangePasswordBody, DeleteAccountBody, LoginBody, SignupBody } from "./api/auth.ts"

export const GatewayApi = HttpApi.make("@integragents/gateway-api/gateway")
  .add(SystemGroup)
  .add(FallbackGroup)
  .add(DelegatedGroup)
  .add(ProvisioningGroup)
  .add(AdministrativeGroup)
  .add(AuthGroup)
  .add(OAuthGroup)

export {
  ApiBadRequest,
  ApiGone,
  ApiNotFound,
  ApiNotImplemented,
  Authority,
  Forbidden,
  GatewayFailure,
  HandoffCollected,
  HandoffExpired,
  HandoffUnknown,
  InvalidCredentials,
  PasswordRequired,
  SignupClosed
}
