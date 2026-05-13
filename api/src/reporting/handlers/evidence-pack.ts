// M08 — GET /api/admin/reports/evidence-pack?call_uuid=X

import type { FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/middleware.js";
import { ReportingService } from "../service.js";
import { evidencePackRequestsTotal, missingCallUuidTotal, reportRequestsTotal } from "../metrics.js";

interface EvidencePackQuery {
  call_uuid?: string;
}

export async function handleEvidencePack(
  req: FastifyRequest,
  reply: FastifyReply,
  prisma: PrismaClient,
  auth: AuthContext,
): Promise<void> {
  reportRequestsTotal.inc({ endpoint: "evidence-pack" });

  const query = req.query as EvidencePackQuery;
  const callUuid = query.call_uuid;

  if (!callUuid) {
    void reply.code(400).send({ error: "missing_call_uuid", message: "?call_uuid= is required" });
    return;
  }

  const tenantId = BigInt(auth.tenantId);
  const svc = new ReportingService(prisma);
  const pack = await svc.getEvidencePack(tenantId, callUuid);

  if (!pack) {
    missingCallUuidTotal.inc();
    evidencePackRequestsTotal.inc({ outcome: "not_found" });
    void reply.code(404).send({ error: "call_uuid_not_found", callUuid });
    return;
  }

  evidencePackRequestsTotal.inc({ outcome: "ok" });

  void reply.code(200).send({
    callUuid: pack.callUuid,
    evidence: {
      originateAudit: pack.originateAudit,
      callWindowAudit: pack.callWindowAudit,
      consentLog: pack.consentLog,
      auditLog: pack.auditLog,
      dncSyncLogContext: pack.dncSyncLogContext,
    },
    meta: {
      hashChainNote: "All rows include prev_hash / row_hash / hash_at per C03. Verify offline with scripts/verify-audit-chain.ts.",
      generatedAt: new Date().toISOString(),
    },
  });
}
