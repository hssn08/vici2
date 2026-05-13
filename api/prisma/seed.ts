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

// =============================================================================
// S03 — Script starter templates
// =============================================================================

async function seedScripts(): Promise<void> {
  const TENANT_ID = 1n;

  const templates = [
    {
      name: 'Default Outbound',
      campaignId: null,
      body: `<h2>Outbound Greeting</h2>
<p>Hello, may I speak with <strong>{lead.first_name} {lead.last_name}</strong>?</p>
<p>Hi {lead.first_name}, this is <strong>{agent.name}</strong> calling on behalf of <em>{campaign.name}</em>.</p>
<p>Is now a good time to talk?</p>

<h3>Purpose of Call</h3>
<p>I'm reaching out today to discuss an opportunity that may interest you.</p>
<p><em>[Pause and wait for response]</em></p>

<h3>Closing</h3>
<p>Thank you for your time today, {lead.first_name}. Have a wonderful day!</p>`,
      active: true,
      version: 1,
      variables: [
        { name: 'lead.first_name' },
        { name: 'lead.last_name' },
        { name: 'agent.name' },
        { name: 'campaign.name' },
      ],
    },
    {
      name: 'Survey Script',
      campaignId: null,
      body: `<h2>Customer Survey</h2>
<p>Hello, is this <strong>{lead.first_name} {lead.last_name}</strong>?</p>
<p>Hi {lead.first_name}, I'm <strong>{agent.name}</strong> and I'm conducting a brief survey today. This will only take about 3 minutes.</p>

<h3>Question 1</h3>
<p>On a scale of 1 to 10, how satisfied are you with our service?</p>
<p><em>[Record answer: ___]</em></p>

<h3>Question 2</h3>
<p>What is the primary reason you chose us?</p>
<ul>
  <li>Price</li>
  <li>Quality</li>
  <li>Recommendation</li>
  <li>Other: ___</li>
</ul>

<h3>Question 3</h3>
<p>Would you recommend us to a friend or colleague?</p>
<p><em>[Record answer: Yes / No / Maybe]</em></p>

<h3>Close</h3>
<p>Thank you so much for your feedback, {lead.first_name}! Your input helps us improve. Have a great day!</p>`,
      active: true,
      version: 1,
      variables: [
        { name: 'lead.first_name' },
        { name: 'lead.last_name' },
        { name: 'agent.name' },
      ],
    },
    {
      name: 'Compliance Disclosure',
      campaignId: null,
      body: `<h2>Regulatory Disclosure</h2>
<p>Hello, this is <strong>{agent.name}</strong>. This call may be recorded for quality assurance purposes.</p>

<h3>Required State Disclosure</h3>
<p>We are required to inform you that this is an outbound call from a call center.</p>
<p>
  <em>
    [If calling {lead.state} resident — check state-specific requirements]
  </em>
</p>

<h3>TCPA Acknowledgment</h3>
<p>You are receiving this call because you previously provided consent to be contacted at {lead.phone_formatted}.</p>
<p>If you wish to be removed from our calling list at any time, please say "Remove me" and I will add you to our Do Not Call list immediately.</p>

<h3>Call Duration Notice</h3>
<p>We have been speaking for {call.duration}.</p>

<blockquote>
  <p><strong>Do Not Call Request Received?</strong> End this call and mark as DNC immediately.</p>
</blockquote>`,
      active: true,
      version: 1,
      variables: [
        { name: 'agent.name' },
        { name: 'lead.state' },
        { name: 'lead.phone_formatted' },
        { name: 'call.duration' },
      ],
    },
  ];

  // Idempotent create: insert only if a script with that name+tenant doesn't exist.
  for (const tpl of templates) {
    const exists = await prisma.script.findFirst({
      where: { tenantId: TENANT_ID, name: tpl.name },
      select: { id: true },
    });
    if (!exists) {
      await prisma.script.create({
        data: {
          tenantId: TENANT_ID,
          name: tpl.name,
          campaignId: tpl.campaignId,
          body: tpl.body,
          active: tpl.active,
          version: tpl.version,
          variables: tpl.variables,
        },
      });
      console.log(`[seed] scripts: created "${tpl.name}"`);
    } else {
      console.log(`[seed] scripts: "${tpl.name}" already exists, skipping`);
    }
  }
}

// ---------------------------------------------------------------------------
// N02 — Seed 7 default English email templates
// ---------------------------------------------------------------------------

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSeed(name: string, ext: 'html' | 'txt'): string {
  return readFileSync(join(__dirname, `email-template-seeds/${name}.${ext}`), 'utf8');
}

async function seedEmailTemplates(): Promise<void> {
  const templates: Array<{
    category: string;
    subject: string;
    htmlBody: string;
    textBody: string;
  }> = [
    {
      category: 'callback_due',
      subject: 'Action required: Callback due — {{callback.leadName}}',
      htmlBody: readSeed('callback_due', 'html'),
      textBody: readSeed('callback_due', 'txt'),
    },
    {
      category: 'callback_upcoming',
      subject: 'Reminder: Callback in {{callback.minutesUntilDue}} minutes — {{callback.leadName}}',
      htmlBody: readSeed('callback_upcoming', 'html'),
      textBody: readSeed('callback_upcoming', 'txt'),
    },
    {
      category: 'import_complete',
      subject: 'Import complete: {{import.fileName}} — {{import.rowsImported}} rows',
      htmlBody: readSeed('import_complete', 'html'),
      textBody: readSeed('import_complete', 'txt'),
    },
    {
      category: 'import_failed',
      subject: 'Import failed: {{import.fileName}} — action required',
      htmlBody: readSeed('import_failed', 'html'),
      textBody: readSeed('import_failed', 'txt'),
    },
    {
      category: 'recording_failed',
      subject: 'Recording failed for call {{recording.callUuid}}',
      htmlBody: readSeed('recording_failed', 'html'),
      textBody: readSeed('recording_failed', 'txt'),
    },
    {
      category: 'agent_disconnected',
      subject: 'Agent disconnected: {{agent.name}} at {{formatDate agent.disconnectedAt "h:mm a"}}',
      htmlBody: readSeed('agent_disconnected', 'html'),
      textBody: readSeed('agent_disconnected', 'txt'),
    },
    {
      category: 'drop_gate_engaged',
      subject: 'Drop gate engaged: {{dropGate.campaignName}} ({{dropGate.dropRate}}% drop rate)',
      htmlBody: readSeed('drop_gate_engaged', 'html'),
      textBody: readSeed('drop_gate_engaged', 'txt'),
    },
  ];

  for (const tpl of templates) {
    const exists = await prisma.emailTemplate.findFirst({
      where: { tenantId: TENANT_ID, category: tpl.category, lang: 'en' },
      select: { id: true },
    });
    if (!exists) {
      await prisma.emailTemplate.create({
        data: {
          tenantId: TENANT_ID,
          category: tpl.category,
          lang: 'en',
          subject: tpl.subject,
          htmlBody: tpl.htmlBody,
          textBody: tpl.textBody,
          active: true,
          version: 1,
        },
      });
      console.log(`[seed] email_templates: created "${tpl.category}" (en)`);
    } else {
      console.log(`[seed] email_templates: "${tpl.category}" (en) already exists, skipping`);
    }
  }
}

async function main(): Promise<void> {
  await seedTenants();
  await seedAuthConfig();
  await seedStatuses();
  await seedPauseCodes();
  await seedCallTimes();
  await seedPhoneCodes();
  await seedZipCodes();
  await seedScripts();
  await seedEmailTemplates();
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
