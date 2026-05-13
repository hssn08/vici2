/**
 * api/src/routes/admin/rnd/override.ts
 *
 * N06 — DELETE /api/admin/rnd/override/:phone
 * Remove a number from reassigned DNC (super_admin only, requires justification).
 *
 * Permission: rnd:override (sensitive, super_admin only)
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getPrisma } from '../../../lib/prisma.js';
import { getRedis } from '../../../lib/redis.js';
import { maskPhone } from '../../../services/rnd/rnd-service.js';

const OVERRIDE_TTL_SECONDS = 55 * 24 * 3600; // 55 days (matches rescrub interval)

type AuthReq = FastifyRequest & {
  auth?: { uid: number; tenantId: number; role: string };
};

function getAuth(req: FastifyRequest) {
  const auth = (req as AuthReq).auth;
  if (!auth) throw Object.assign(new Error('Unauthenticated'), { statusCode: 401 });
  return auth;
}

const OverrideBodySchema = z.object({
  justification: z.string().min(10).max(1000),
});

export async function handleOverride(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = getAuth(req);
  const tenantId = BigInt(auth.tenantId);
  const db = getPrisma();

  const params = req.params as { phone: string };
  const phone = decodeURIComponent(params.phone);

  const parsed = OverrideBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
  }
  const { justification } = parsed.data;

  // Remove from dnc table
  const result = await db.$executeRaw`
    DELETE FROM dnc
    WHERE tenant_id = ${tenantId}
      AND phone_e164 = ${phone}
      AND source = 'reassigned'
  `;

  if (result === 0) {
    return reply.code(404).send({
      error: 'not_found',
      message: 'No reassigned DNC entry found for this phone number',
    });
  }

  // Set a short-circuit override key in Valkey (Bloom filter doesn't support deletion)
  // This key is checked by DNC lookup to bypass the Bloom filter hit for overridden numbers
  const redis = getRedis();
  const phoneHash = createHash('sha256').update(phone).digest('hex').slice(0, 16);
  const overrideKey = `t:${tenantId}:rnd:override:${phoneHash}`;
  await redis.set(overrideKey, '1', 'EX', OVERRIDE_TTL_SECONDS);

  // Audit
  await db.$executeRaw`
    INSERT INTO audit_log
      (tenant_id, actor_user_id, actor_kind, action, entity_type, entity_id, after_json, ts)
    VALUES (
      ${tenantId}, ${BigInt(auth.uid)}, 'user', 'rnd.override.applied',
      'dnc', ${phone},
      ${JSON.stringify({
        phone_e164_masked: maskPhone(phone),
        justification,
        user_id: auth.uid,
        source: 'reassigned',
      })},
      NOW(6)
    )
  `;

  return reply.code(200).send({
    success: true,
    phone_masked: maskPhone(phone),
    dnc_removed: true,
    override_ttl_days: 55,
    message: 'Reassigned DNC entry removed. Re-scrub will restore if the number is still marked by RND.',
  });
}
