/**
 * api/src/routes/recordings/list.ts
 *
 * GET /api/recordings
 *
 * Search + filter recordings with cursor pagination.
 * R03 PLAN §1.
 *
 * Filters: date_from, date_to, campaign_id, agent_id, lead_phone_last4,
 *          call_uuid, has_transcript, has_legal_hold, lifecycle_state,
 *          consent_status.
 * Pagination: keyset on (start_time DESC, id DESC) via after_id cursor.
 * RBAC: recording:list.
 *   - super_admin / admin / viewer → tenant scope (all recordings)
 *   - supervisor → group scope (campaigns in user_group)
 *   - agent → own scope (user_id = auth.uid)
 * Audit: recording.list written on every request.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../../lib/prisma.js';
import { audit } from '../../auth/audit.js';
import type { AuthContext } from '../../auth/middleware.js';

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

const QuerySchema = z.object({
  after_id:         z.coerce.bigint().optional(),
  limit:            z.coerce.number().int().min(1).max(200).default(50),
  date_from:        z.string().optional(),
  date_to:          z.string().optional(),
  campaign_id:      z.coerce.number().int().positive().optional(),
  agent_id:         z.coerce.number().int().positive().optional(),
  lead_phone_last4: z.string().regex(/^\d{4}$/).optional(),
  call_uuid:        z.string().uuid().optional(),
  has_transcript:   z.enum(['true', 'false']).optional(),
  has_legal_hold:   z.enum(['true', 'false']).optional(),
  lifecycle_state:  z.enum(['pending','uploading','uploaded','available','archived','deleted','failed']).optional(),
  consent_status:   z.string().optional(),
});

// ---------------------------------------------------------------------------
// Row shape returned from raw SQL
// ---------------------------------------------------------------------------

interface RecordingListRow {
  id:               bigint;
  call_uuid:        string;
  start_time:       Date;
  duration_sec:     number | null;
  campaign_id:      bigint | null;
  campaign_name:    string | null;
  user_id:          bigint | null;
  agent_name:       string | null;
  lead_phone:       string | null;
  lifecycle_state:  string;
  consent_status:   string;
  transcript_status:string;
  has_legal_hold:   number | boolean; // MySQL TINYINT → number
  size_bytes:       bigint | null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerRecordingListRoute(app: FastifyInstance | any): Promise<void> {
  app.get(
    '/api/recordings',
    {
      preHandler: [app.requireAuth],
    },
    async (
      req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>,
      reply: FastifyReply,
    ) => {
      const auth = (req as FastifyRequest & { auth?: AuthContext }).auth;
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });

      // recording:list permission check
      if (!auth.perms.has('recording:list')) {
        return reply.code(403).send({ error: 'forbidden', required: 'recording:list' });
      }

      const parsed = QuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
      }
      const q = parsed.data;

      const prisma = getPrisma();
      const tenantId = BigInt(auth.tenantId);

      // ---------- Build WHERE clauses ------------------------------------

      // Scope conditions (role-based)
      const scopeConditions: string[] = [`rl.tenant_id = ${tenantId}`];

      if (auth.role === 'agent') {
        // agent: own calls only
        scopeConditions.push(`rl.user_id = ${BigInt(auth.uid)}`);
      } else if (auth.role === 'supervisor') {
        // supervisor: campaigns within their user_group
        if (auth.allowedCampaigns !== '*' && auth.allowedCampaigns.length > 0) {
          const ids = auth.allowedCampaigns.join(',');
          scopeConditions.push(`rl.campaign_id IN (${ids})`);
        } else if (auth.allowedCampaigns !== '*') {
          // no campaigns in group → return empty
          scopeConditions.push('1=0');
        }
      }
      // super_admin, admin, viewer → tenant-wide (no extra condition)

      // Filter conditions
      const filterConditions: string[] = [];

      if (q.after_id !== undefined) {
        // Keyset: rows before cursor by (start_time ASC, id ASC is reversed to DESC)
        // We want start_time < cursor_time OR (start_time = cursor_time AND id < cursor_id)
        // but we need the cursor row's start_time — so we do a simpler approach: id < after_id
        // (IDs are monotonically increasing bigints so this is correct for DESC order)
        filterConditions.push(`rl.id < ${q.after_id}`);
      }

      if (q.date_from) {
        filterConditions.push(`rl.start_time >= '${q.date_from} 00:00:00'`);
      }
      if (q.date_to) {
        filterConditions.push(`rl.start_time <= '${q.date_to} 23:59:59'`);
      }
      if (q.campaign_id !== undefined) {
        filterConditions.push(`rl.campaign_id = ${q.campaign_id}`);
      }
      if (q.agent_id !== undefined) {
        filterConditions.push(`rl.user_id = ${q.agent_id}`);
      }
      if (q.lead_phone_last4) {
        // Match last4 digits of lead_phone (which is stored in leads table joined below)
        filterConditions.push(`RIGHT(l.phone_number, 4) = '${q.lead_phone_last4.replace(/'/g, '')}'`);
      }
      if (q.call_uuid) {
        filterConditions.push(`rl.uuid = '${q.call_uuid.replace(/'/g, '')}'`);
      }
      if (q.has_transcript === 'true') {
        filterConditions.push(`rl.transcript_status = 'completed'`);
      } else if (q.has_transcript === 'false') {
        filterConditions.push(`rl.transcript_status != 'completed'`);
      }
      if (q.has_legal_hold === 'true') {
        filterConditions.push(`r.legal_hold = TRUE`);
      } else if (q.has_legal_hold === 'false') {
        filterConditions.push(`(r.legal_hold IS NULL OR r.legal_hold = FALSE)`);
      }
      if (q.lifecycle_state) {
        filterConditions.push(`rl.lifecycle_state = '${q.lifecycle_state.replace(/'/g, '')}'`);
      }
      if (q.consent_status) {
        filterConditions.push(`rl.consent_status = '${q.consent_status.replace(/'/g, '')}'`);
      }

      const allConditions = [...scopeConditions, ...filterConditions];
      const whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(' AND ')}` : '';

      const limit = q.limit;

      // ---------- Main list query ----------------------------------------

      const rows = await prisma.$queryRawUnsafe<RecordingListRow[]>(`
        SELECT
          rl.id,
          rl.uuid          AS call_uuid,
          rl.start_time,
          rl.duration_sec,
          rl.campaign_id,
          c.name           AS campaign_name,
          rl.user_id,
          CONCAT(u.first_name, ' ', u.last_name) AS agent_name,
          l.phone_number   AS lead_phone,
          rl.lifecycle_state,
          rl.consent_status,
          rl.transcript_status,
          COALESCE(r.legal_hold, 0) AS has_legal_hold,
          rl.size_bytes
        FROM recording_log rl
        LEFT JOIN campaigns  c  ON c.id  = rl.campaign_id  AND c.tenant_id  = rl.tenant_id
        LEFT JOIN users      u  ON u.id  = rl.user_id      AND u.tenant_id  = rl.tenant_id
        LEFT JOIN leads      l  ON l.id  = rl.lead_id      AND l.tenant_id  = rl.tenant_id
        LEFT JOIN recordings r  ON r.recording_log_id = rl.id AND r.tenant_id = rl.tenant_id
        ${whereClause}
        ORDER BY rl.id DESC
        LIMIT ${limit + 1}
      `);

      // Determine next cursor
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? pageRows[pageRows.length - 1]?.id?.toString() ?? null : null;

      // ---------- Approximate total (count without cursor) ---------------
      // Only compute for first page (no after_id) to avoid expensive COUNT on deep pages
      let totalHint: number | null = null;
      if (q.after_id === undefined) {
        const countConditions = scopeConditions.join(' AND ');
        const countWhere = countConditions ? `WHERE ${countConditions}` : '';
        const countRows = await prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(`
          SELECT COUNT(*) AS cnt
          FROM recording_log rl
          LEFT JOIN recordings r ON r.recording_log_id = rl.id AND r.tenant_id = rl.tenant_id
          ${countWhere}
        `);
        totalHint = Number(countRows[0]?.cnt ?? 0);
      }

      // ---------- Mask lead phone (show last 4 digits only) --------------
      const isMaskingRole = !['super_admin', 'admin'].includes(auth.role);

      const recordings = pageRows.map((row: RecordingListRow) => {
        const phone = row.lead_phone;
        const maskedPhone = phone
          ? isMaskingRole
            ? `***-***-${phone.slice(-4)}`
            : phone
          : null;

        return {
          id:              row.id.toString(),
          call_uuid:       row.call_uuid,
          start_time:      row.start_time instanceof Date ? row.start_time.toISOString() : String(row.start_time),
          duration_sec:    row.duration_sec,
          campaign_id:     row.campaign_id?.toString() ?? null,
          campaign_name:   row.campaign_name,
          agent_id:        row.user_id?.toString() ?? null,
          agent_name:      row.agent_name,
          lead_phone:      maskedPhone,
          lifecycle_state: row.lifecycle_state,
          consent_status:  row.consent_status,
          has_transcript:  row.transcript_status === 'completed',
          has_legal_hold:  Boolean(row.has_legal_hold),
          size_bytes:      row.size_bytes?.toString() ?? null,
        };
      });

      // ---------- Audit --------------------------------------------------
      await audit({
        tx: prisma,
        actorUserId: auth.uid,
        actorKind:   'user',
        action:      'recording.list' as const,
        tenantId:    auth.tenantId,
        entityType:  'recording_log',
        entityId:    null,
        afterJson:   { filters: req.query, result_count: recordings.length },
        ip:          req.ip,
        userAgent:   req.headers['user-agent'],
        requestId:   (req as FastifyRequest & { id?: string }).id,
      });

      return reply.send({
        recordings,
        next_cursor: nextCursor,
        total_hint:  totalHint,
      });
    },
  );
}
