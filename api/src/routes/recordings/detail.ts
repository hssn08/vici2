/**
 * api/src/routes/recordings/detail.ts
 *
 * GET /api/recordings/:id/detail
 *
 * Rich detail view for R03 playback UI. Returns all metadata needed to
 * render the detail page: recording metadata, call context (campaign, agent,
 * lead, disposition), transcript status, legal hold state.
 *
 * This is distinct from R02's GET /api/recordings/:id which returns raw
 * storage metadata. R03's detail endpoint joins additional context tables
 * and is purpose-built for the playback UI.
 *
 * R03 PLAN §2.
 *
 * RBAC: recording:list (same as list).
 * Audit: recording.accessed on every request.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma } from '../../lib/prisma.js';
import { audit } from '../../auth/audit.js';
import type { AuthContext } from '../../auth/middleware.js';

interface RecordingDetailRow {
  id:                 bigint;
  call_uuid:          string;
  start_time:         Date;
  duration_sec:       number | null;
  size_bytes:         bigint | null;
  sha256:             Buffer | null;
  lifecycle_state:    string;
  consent_status:     string;
  failure_reason:     string | null;
  encoded_at:         Date | null;
  campaign_id:        bigint | null;
  campaign_name:      string | null;
  user_id:            bigint | null;
  agent_first_name:   string | null;
  agent_last_name:    string | null;
  lead_id:            bigint | null;
  lead_phone:         string | null;
  disposition:        string | null;
  transcript_status:  string;
  transcript_word_count: number | null;
  transcript_uri:     string | null;
  legal_hold:         number | boolean | null;
  legal_hold_reason:  string | null;
  storage_url:        string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerRecordingDetailRoute(app: FastifyInstance | any): Promise<void> {
  app.get(
    '/api/recordings/:id/detail',
    {
      preHandler: [app.requireAuth],
    },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const auth = (req as FastifyRequest & { auth?: AuthContext }).auth;
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });

      // recording:list permission check
      if (!auth.perms.has('recording:list')) {
        return reply.code(403).send({ error: 'forbidden', required: 'recording:list' });
      }

      const recordingLogId = BigInt(req.params.id);
      const tenantId = BigInt(auth.tenantId);
      const prisma = getPrisma();

      const rows = await prisma.$queryRaw<RecordingDetailRow[]>`
        SELECT
          rl.id,
          rl.uuid           AS call_uuid,
          rl.start_time,
          rl.duration_sec,
          rl.size_bytes,
          rl.sha256,
          rl.lifecycle_state,
          rl.consent_status,
          rl.failure_reason,
          rl.encoded_at,
          rl.campaign_id,
          c.name            AS campaign_name,
          rl.user_id,
          u.first_name      AS agent_first_name,
          u.last_name       AS agent_last_name,
          rl.lead_id,
          l.phone_number    AS lead_phone,
          lc.status         AS disposition,
          rl.transcript_status,
          rl.transcript_word_count,
          rl.transcript_uri,
          rl.storage_url,
          r.legal_hold,
          r.legal_hold_reason
        FROM recording_log rl
        LEFT JOIN campaigns  c  ON c.id  = rl.campaign_id  AND c.tenant_id  = rl.tenant_id
        LEFT JOIN users      u  ON u.id  = rl.user_id      AND u.tenant_id  = rl.tenant_id
        LEFT JOIN leads      l  ON l.id  = rl.lead_id      AND l.tenant_id  = rl.tenant_id
        LEFT JOIN lead_calls lc ON lc.lead_id = rl.lead_id AND lc.unique_id = rl.uuid
        LEFT JOIN recordings r  ON r.recording_log_id = rl.id AND r.tenant_id = rl.tenant_id
        WHERE rl.id = ${recordingLogId}
          AND rl.tenant_id = ${tenantId}
        LIMIT 1
      `;

      const row = rows[0];
      if (!row) return reply.code(404).send({ error: 'not_found' });

      // Scope enforcement
      if (auth.role === 'agent') {
        if (!row.user_id || row.user_id.toString() !== String(auth.uid)) {
          return reply.code(404).send({ error: 'not_found' }); // 404 not 403 to avoid enumeration
        }
      } else if (auth.role === 'supervisor') {
        if (auth.allowedCampaigns !== '*' && row.campaign_id !== null) {
          const campaignId = row.campaign_id;
          const allowed = auth.allowedCampaigns.map(String);
          if (!allowed.includes(campaignId.toString())) {
            return reply.code(404).send({ error: 'not_found' });
          }
        }
      }

      // Mask lead phone for non-admin roles
      const isMaskingRole = !['super_admin', 'admin'].includes(auth.role);
      const maskedPhone = row.lead_phone
        ? isMaskingRole
          ? `***-***-${row.lead_phone.slice(-4)}`
          : row.lead_phone
        : null;

      // Build storage_url_prefix for UI use (never expose full key directly)
      let storageUrlPrefix: string | null = null;
      if (row.storage_url) {
        const lastSlash = row.storage_url.lastIndexOf('/');
        storageUrlPrefix = lastSlash > 0 ? row.storage_url.slice(0, lastSlash + 1) : null;
      }

      // Audit
      await audit({
        tx:          prisma,
        actorUserId: auth.uid,
        actorKind:   'user',
        action:      'recording.accessed' as const,
        tenantId:    auth.tenantId,
        entityType:  'recording_log',
        entityId:    recordingLogId.toString(),
        ip:          req.ip,
        userAgent:   req.headers['user-agent'],
        requestId:   (req as FastifyRequest & { id?: string }).id,
      });

      return reply.send({
        id:                   row.id.toString(),
        call_uuid:            row.call_uuid,
        start_time:           row.start_time instanceof Date ? row.start_time.toISOString() : String(row.start_time),
        duration_sec:         row.duration_sec,
        size_bytes:           row.size_bytes?.toString() ?? null,
        sha256:               row.sha256 ? row.sha256.toString('hex') : null,
        lifecycle_state:      row.lifecycle_state,
        consent_status:       row.consent_status,
        failure_reason:       row.failure_reason,
        encoded_at:           row.encoded_at instanceof Date ? row.encoded_at.toISOString() : null,
        campaign_id:          row.campaign_id?.toString() ?? null,
        campaign_name:        row.campaign_name,
        agent_id:             row.user_id?.toString() ?? null,
        agent_name:           row.agent_first_name && row.agent_last_name
                                ? `${row.agent_first_name} ${row.agent_last_name}`
                                : null,
        lead_id:              row.lead_id?.toString() ?? null,
        lead_phone:           maskedPhone,
        disposition:          row.disposition,
        transcript_status:    row.transcript_status,
        transcript_word_count: row.transcript_word_count,
        has_legal_hold:       Boolean(row.legal_hold),
        legal_hold_reason:    row.legal_hold_reason,
        storage_url_prefix:   storageUrlPrefix,
        // Capabilities for the UI to know what actions are available
        can_listen:           auth.perms.has('recording:download'),
        can_download:         auth.perms.has('recording:download'),
        can_legal_hold:       auth.role === 'super_admin',
        can_integrity_verify: ['super_admin', 'admin'].includes(auth.role),
      });
    },
  );
}
