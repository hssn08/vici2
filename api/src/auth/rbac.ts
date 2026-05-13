// Re-export RBAC constants from shared/types so server code has one import.

export {
  ROLES,
  VERBS,
  PERMISSIONS,
  ROLE_HIERARCHY,
  HIERARCHICAL_ROLES,
  ROLE_VERBS,
  ROLE_PERMISSIONS,
  SENSITIVE_VERBS,
  roleAtLeast,
  hasPermission,
  permissionsFor,
  isRole,
  type Role,
  type Verb,
  type Permission,
  type Grant,
  type Scope,
} from "@vici2/types";

import type { Verb, Role } from "@vici2/types";
import { permissionsFor as permsFor } from "@vici2/types";

export function permsAsSet(role: Role): Set<Verb> {
  return new Set(permsFor(role));
}
