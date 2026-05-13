// M01 — Admin route aggregate registration.
//
// All admin routes live under /api/admin/* and require at minimum the
// requireAuth decorator (already registered by registerAuthRoutes).
// Individual routes add requirePermission preHandlers for fine-grained RBAC.

import { registerAdminUserRoutes } from "./users/index.js";
import { registerAdminSettingsRoutes } from "./settings/index.js";
import { registerAdminIngroupRoutes } from "./ingroups.js";
import { registerAdminAlertReceiverRoutes } from "./alert-receivers/index.js";
import { registerAuditLogRoutes } from "./audit/index.js";
import { AuditLogViewerService } from "./audit/service.js";
import { AuditReader } from "../../services/audit/reader.js";
import { AuditVerifier } from "../../services/audit/verifier.js";
import { AuditWriter } from "../../services/audit/writer.js";
import { getPrisma } from "../../lib/prisma.js";
import { registerAdminIvrRoutes } from "./ivr.js";
// M06 — Carrier / Gateway / DID admin
import { registerAdminCarrierRoutes } from "./carriers/index.js";
import { registerAdminDidRoutes } from "./dids/index.js";
// W02 — Jobs queue admin
import { registerAdminJobRoutes } from "./jobs/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAdminRoutes(app: any): Promise<void> {
  await registerAdminUserRoutes(app);
  await registerAdminSettingsRoutes(app);
  await registerAdminIngroupRoutes(app);
  await registerAdminAlertReceiverRoutes(app);

  // M04 — Audit log viewer
  const db = getPrisma();
  const auditWriter = new AuditWriter(db);
  const auditVerifier = new AuditVerifier({
    db,
    pubKeys: {
      // Phase 1: no public-key validation (returns null → signature check skipped)
      async getPublicKey(_keyId: string) { return null; },
    },
  });
  const auditReader = new AuditReader({ db, writer: auditWriter, verifier: auditVerifier });
  const auditViewerService = new AuditLogViewerService(auditReader, auditVerifier);
  await registerAuditLogRoutes(app, auditViewerService);

  // I02 — IVR engine admin
  await registerAdminIvrRoutes(app);

  // M06 — Carrier / Gateway / DID admin
  await registerAdminCarrierRoutes(app);
  await registerAdminDidRoutes(app);

  // W02 — Jobs queue admin
  await registerAdminJobRoutes(app);
}
