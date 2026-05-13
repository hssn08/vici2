/* eslint-disable no-console */
/**
 * F02 — Prisma seed.
 *
 * Per F02 PLAN §11 + orchestrator amendments A1–A6.
 *
 * Seeds:
 *   - tenants(1)                    "Default" / id=1
 *   - statuses(20+)                 system defaults under campaign_id='__SYS__'
 *   - pause_codes(7)                system defaults under campaign_id NULL
 *   - call_times(1)                 9am-9pm with WA/LA/MS overrides
 *   - phone_codes (starter CSV)     A1 NPA+NXX granular reference
 *   - zip_codes   (starter CSV)     A4 ZIP cascade reference
 *   - auth_config(1)                A3 single-row settings (defaults)
 *
 * Does NOT seed (per amendment A6):
 *   - super_admin user — F05 IMPLEMENT owns the bootstrap
 *
 * Idempotent: re-runs are safe. Uses upsert / createMany skipDuplicates.
 *
 * Run: `cd api && pnpm prisma db seed`  (or `make db-seed`)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

interface PhoneCodeRow {
  area_code: string;
  exchange_code: string;
  state: string | null;
  county: string | null;
  tz_iana: string;
  confidence: 'NPA' | 'NXX';
}

interface ZipCodeRow {
  zip: string;
  tz_iana: string;
  state: string | null;
  confidence: 'ZIP';
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i += 1) {
      row[header[i]] = cells[i] ?? '';
    }
    return row;
  });
}

async function seedTenants(): Promise<void> {
  console.log('[seed] tenants');
  await prisma.tenant.upsert({
    where: { id: 1n },
    update: {},
    create: {
      id: 1n,
      name: 'Default',
      slug: 'default',
      active: true,
      settings: {},
    },
  });
}

async function seedAuthConfig(): Promise<void> {
  console.log('[seed] auth_config (single row)');
  await prisma.authConfig.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
}

interface D04StatusSeed {
  status: string;
  description: string;
  selectable: boolean;
  humanAnswered: boolean;
  sale: boolean;
  dnc: boolean;
  callback: boolean;
  notInterested: boolean;
  hotkey: string | null;
  recycleDelaySeconds: number | null;
  category: string | null;
  systemOwner: string | null;
}

async function seedStatuses(): Promise<void> {
  console.log('[seed] statuses (D04 canonical 35-row taxonomy)');
  const seedPath = join(repoRoot, 'db', 'seeds', 'system-statuses.json');
  const defaults: D04StatusSeed[] = JSON.parse(readFileSync(seedPath, 'utf8')) as D04StatusSeed[];
  for (const s of defaults) {
    await prisma.status.upsert({
      where: { tenantId_campaignId_status: { tenantId: 1n, campaignId: '__SYS__', status: s.status } },
      update: {
        description: s.description,
        selectable: s.selectable,
        humanAnswered: s.humanAnswered,
        sale: s.sale,
        dnc: s.dnc,
        callback: s.callback,
        notInterested: s.notInterested,
        hotkey: s.hotkey,
        recycleDelaySeconds: s.recycleDelaySeconds,
        category: s.category,
        systemOwner: s.systemOwner,
      },
      create: {
        tenantId: 1n,
        campaignId: '__SYS__',
        status: s.status,
        description: s.description,
        selectable: s.selectable,
        humanAnswered: s.humanAnswered,
        sale: s.sale,
        dnc: s.dnc,
        callback: s.callback,
        notInterested: s.notInterested,
        hotkey: s.hotkey,
        recycleDelaySeconds: s.recycleDelaySeconds,
        category: s.category,
        systemOwner: s.systemOwner,
      },
    });
  }
  console.log(`[seed] statuses: ${defaults.length} rows`);
}

async function seedPauseCodes(): Promise<void> {
  console.log('[seed] pause_codes (system defaults)');
  const codes = [
    { code: 'BREAK', name: 'Break', billable: true },
    { code: 'LUNCH', name: 'Lunch', billable: false },
    { code: 'BIO', name: 'Restroom', billable: true },
    { code: 'TRAIN', name: 'Training', billable: true },
    { code: 'TECH', name: 'Tech issue', billable: true },
    { code: 'ADMIN', name: 'Admin', billable: true },
    { code: 'MEET', name: 'Meeting', billable: true },
  ];
  for (const c of codes) {
    // Functional UNIQUE index on (tenant_id, IFNULL(campaign_id,'__SYS__'),
    // code) is enforced by 20260506201800_pause_codes_unique. Prisma's
    // upsert can't see functional indexes, so we look up first.
    const existing = await prisma.pauseCode.findFirst({
      where: { tenantId: 1n, campaignId: null, code: c.code },
    });
    if (existing) {
      await prisma.pauseCode.update({
        where: { id: existing.id },
        data: { name: c.name, billable: c.billable },
      });
    } else {
      await prisma.pauseCode.create({
        data: {
          tenantId: 1n,
          campaignId: null,
          code: c.code,
          name: c.name,
          billable: c.billable,
        },
      });
    }
  }
}

async function seedCallTimes(): Promise<void> {
  console.log('[seed] call_times (default 9am-9pm + state overrides)');
  await prisma.callTime.upsert({
    where: { tenantId_name: { tenantId: 1n, name: 'Default 9am-9pm safe' } },
    update: {},
    create: {
      tenantId: 1n,
      name: 'Default 9am-9pm safe',
      stateOverrides: {
        WA: ['08:00', '20:00'],
        LA: ['08:00', '20:00'],
        MS: ['08:00', '20:00'],
      },
    },
  });
}

async function seedPhoneCodes(): Promise<void> {
  console.log('[seed] phone_codes (starter CSV)');
  const csvPath = join(repoRoot, 'db', 'seeds', 'phone_codes_starter.csv');
  const rows = parseCsv(readFileSync(csvPath, 'utf8')) as unknown as PhoneCodeRow[];
  for (const r of rows) {
    await prisma.phoneCode.upsert({
      where: {
        areaCode_exchangeCode: {
          areaCode: r.area_code,
          exchangeCode: r.exchange_code,
        },
      },
      update: {
        state: r.state || null,
        county: r.county || null,
        tzIana: r.tz_iana,
        confidence: r.confidence,
      },
      create: {
        areaCode: r.area_code,
        exchangeCode: r.exchange_code,
        state: r.state || null,
        county: r.county || null,
        tzIana: r.tz_iana,
        confidence: r.confidence,
      },
    });
  }
  console.log(`[seed] phone_codes: ${rows.length} rows`);
}

async function seedZipCodes(): Promise<void> {
  console.log('[seed] zip_codes (starter CSV)');
  const csvPath = join(repoRoot, 'db', 'seeds', 'zip_codes_starter.csv');
  const rows = parseCsv(readFileSync(csvPath, 'utf8')) as unknown as ZipCodeRow[];
  for (const r of rows) {
    await prisma.zipCode.upsert({
      where: { zip: r.zip },
      update: {
        tzIana: r.tz_iana,
        state: r.state || null,
        confidence: r.confidence,
      },
      create: {
        zip: r.zip,
        tzIana: r.tz_iana,
        state: r.state || null,
        confidence: r.confidence,
      },
    });
  }
  console.log(`[seed] zip_codes: ${rows.length} rows`);
}

async function main(): Promise<void> {
  await seedTenants();
  await seedAuthConfig();
  await seedStatuses();
  await seedPauseCodes();
  await seedCallTimes();
  await seedPhoneCodes();
  await seedZipCodes();
  console.log('[seed] done');
  console.log('[seed] note: super_admin user is NOT created here (per F02 amendment A6).');
  console.log('[seed]       Run F05 bootstrap (`make db-bootstrap-superadmin`) after F05 IMPLEMENT lands.');
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
