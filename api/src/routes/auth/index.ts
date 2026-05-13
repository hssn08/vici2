// Aggregate auth routes registration.

import { registerAuthDecorators } from "../../auth/middleware.js";
import { registerJwksRoute } from "./jwks.js";
import { registerLoginRoute } from "./login.js";
import { registerLogoutRoutes } from "./logout.js";
import { registerMeRoute } from "./me.js";
import { registerPasswordChangeRoute } from "./password-change.js";
import { registerRefreshRoute } from "./refresh.js";
import { registerSipRotateRoute } from "./sip-rotate.js";
import { registerTotpRoutes } from "./totp.js";
import { registerWsTokenRoute } from "./ws-token.js";

// Using `any` here intentionally: the server instance is created with a
// custom loggerInstance whose concrete generic types differ from the default
// FastifyInstance; the route registrars only depend on the decorated methods.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAuthRoutes(app: any): Promise<void> {
  await registerAuthDecorators(app);
  registerJwksRoute(app);
  registerLoginRoute(app);
  registerRefreshRoute(app);
  registerLogoutRoutes(app);
  registerMeRoute(app);
  registerWsTokenRoute(app);
  registerPasswordChangeRoute(app);
  registerSipRotateRoute(app);
  registerTotpRoutes(app);
}
