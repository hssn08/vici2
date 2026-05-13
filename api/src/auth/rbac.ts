// Re-export RBAC constants from shared/types so server code has one import.

export {
  ROLES,
  PERMISSIONS,
  ROLE_HIERARCHY,
  ROLE_PERMISSIONS,
  roleAtLeast,
  hasPermission,
  permissionsFor,
  type Role,
  type Permission,
} from "@vici2/types";

import type { Permission, Role } from "@vici2/types";
import { ROLES as ROLES_SRC, permissionsFor as permsFor } from "@vici2/types";

export function isRole(s: string): s is Role {
  return (ROLES_SRC as readonly string[]).includes(s);
}

export function permsAsSet(role: Role): Set<Permission> {
  return new Set(permsFor(role));
}
