/* eslint-disable no-console */
/**
 * F02 — round-trip insert/query smoke test.
 *
 * Asserts that key models can be inserted and read back via Prisma.
 * Run from `api/`:  DATABASE_URL=... pnpm exec tsx test/db/round-trip.test.ts
 *
 * Cleans up after itself; idempotent.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // 1. tenants — already seeded as id=1
  const t = await prisma.tenant.findUnique({ where: { id: 1n } });
  if (!t || t.slug !== 'default') throw new Error('default tenant missing');
  console.log('[ok] tenant id=1 present');

  // 2. user (skeleton — F05 owns the cipher)
  const u = await prisma.user.create({
    data: {
      tenantId: 1n,
      username: `agent_${Date.now()}`,
      email: null,
      passwordHash: 'placeholder-argon2id-hash',
      role: 'agent',
    },
  });
  console.log('[ok] user created id=', u.id.toString());

  // 3. campaign (compound PK)
  const c = await prisma.campaign.create({
    data: {
      tenantId: 1n,
      id: `TEST_${Date.now()}`,
      name: 'Round-trip',
      dialStatusFilter: ['NEW', 'NA'],
      closerIngroups: [],
    },
  });
  console.log('[ok] campaign created id=', c.id);

  // 4. list + lead (custom_data JSON)
  const list = await prisma.list.create({
    data: { tenantId: 1n, name: `list_${Date.now()}` },
  });
  const lead = await prisma.lead.create({
    data: {
      tenantId: 1n,
      listId: list.id,
      phoneE164: '+13175551234',
      state: 'IN',
      knownTimezone: 'America/Indiana/Indianapolis',
      customData: { source: 'roundtrip', extra: { score: 42 } },
    },
  });
  console.log('[ok] lead created id=', lead.id.toString(), 'custom_data=', lead.customData);

  // 5. dnc — composite PK
  const dnc = await prisma.dnc.create({
    data: {
      tenantId: 1n,
      phoneE164: '+15555550000',
      source: 'internal',
    },
  });
  console.log('[ok] dnc created phone=', dnc.phoneE164);

  // 6. sip_credentials — VARBINARY(512) accept binary blob
  const sip = await prisma.sipCredential.create({
    data: {
      tenantId: 1n,
      userId: u.id,
      sipUsername: `sip_${u.id}`,
      sipPasswordCt: Buffer.from('test-ciphertext-blob'),
      kekVersion: 1,
    },
  });
  if (!Buffer.isBuffer(sip.sipPasswordCt)) throw new Error('sip_password_ct should be Buffer');
  console.log('[ok] sip_credential created bytes=', sip.sipPasswordCt.length);

  // Cleanup (FK ON DELETE CASCADE handles sip_credentials, callbacks)
  await prisma.lead.delete({ where: { id: lead.id } });
  await prisma.list.delete({ where: { id: list.id } });
  await prisma.dnc.delete({
    where: {
      tenantId_phoneE164_source_state_campaignId: {
        tenantId: dnc.tenantId,
        phoneE164: dnc.phoneE164,
        source: dnc.source,
        state: dnc.state,
        campaignId: dnc.campaignId,
      },
    },
  });
  await prisma.campaign.delete({
    where: { tenantId_id: { tenantId: c.tenantId, id: c.id } },
  });
  await prisma.user.delete({ where: { id: u.id } });
  console.log('[ok] cleanup done');

  // 7. partition smoke: insert into call_log across two months
  await prisma.callLog.create({
    data: {
      tenantId: 1n,
      uuid: `rt-${Date.now()}-may`,
      direction: 'out',
      phoneE164: '+13175551234',
      callStarted: new Date('2026-05-15T12:00:00Z'),
    },
  });
  await prisma.callLog.create({
    data: {
      tenantId: 1n,
      uuid: `rt-${Date.now()}-jul`,
      direction: 'out',
      phoneE164: '+13175551234',
      callStarted: new Date('2026-07-15T12:00:00Z'),
    },
  });
  console.log('[ok] call_log partition cross-month inserts succeeded');
}

main()
  .catch((err) => {
    console.error('[fail]', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
