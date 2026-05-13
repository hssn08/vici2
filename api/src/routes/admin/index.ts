// M01 — Admin route aggregate registration.
//
// All admin routes live under /api/admin/* and require at minimum the
// requireAuth decorator (already registered by registerAuthRoutes).
// Individual routes add requirePermission preHandlers for fine-grained RBAC.

import { registerAdminUserRoutes } from "./users/index.js";
import { registerAdminSettingsRoutes } from "./settings/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAdminRoutes(app: any): Promise<void> {
  await registerAdminUserRoutes(app);
  await registerAdminSettingsRoutes(app);
}
