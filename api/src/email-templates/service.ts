// N02 — Email template service.
// renderEmail(): single render path for the email-delivery worker.
// CRUD service functions for admin API.

import pino from 'pino';
import client from 'prom-client';
import { getPrisma } from '../lib/prisma.js';

// Use a local alias that matches the return type of getPrisma()
type PrismaClient = ReturnType<typeof getPrisma>;

import { hbs } from './handlebars.js';
import { sanitizeEmailHtml } from './sanitize.js';
import { htmlToText } from './to-text.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'n02' },
});

const renderErrorTotal = new client.Counter({
  name: 'vici2_n02_render_error_total',
  help: 'Total Handlebars template compilation/render errors',
  labelNames: ['category'] as const,
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TemplateNotFoundError extends Error {
  constructor(tenantId: bigint, category: string, lang: string) {
    super(
      `No active email template for tenant=${tenantId} category=${category} lang=${lang}`,
    );
    this.name = 'TemplateNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RenderEmailResult {
  subject: string;
  html: string;
  text: string;
}

export interface EmailTemplateDto {
  id: string;
  tenantId: string;
  category: string;
  lang: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmailTemplateVersionDto {
  id: string;
  version: number;
  subject: string;
  htmlBody: string;
  textBody: string;
  savedAt: string;
}

export interface CreateTemplateInput {
  tenantId: bigint;
  category: string;
  lang?: string;
  subject: string;
  htmlBody: string;
  textBody?: string;
}

export interface PatchTemplateInput {
  subject?: string;
  htmlBody?: string;
  textBody?: string;
  active?: boolean;
}

// ---------------------------------------------------------------------------
// renderEmail()
// ---------------------------------------------------------------------------

export async function renderEmail(
  prisma: PrismaClient,
  tenantId: bigint,
  category: string,
  lang: string,
  vars: Record<string, unknown>,
): Promise<RenderEmailResult> {
  // 1. Look up template with lang fallback to 'en'
  let template = await prisma.emailTemplate.findFirst({
    where: { tenantId, category, lang, active: true },
  });

  if (!template && lang !== 'en') {
    template = await prisma.emailTemplate.findFirst({
      where: { tenantId, category, lang: 'en', active: true },
    });
  }

  if (!template) {
    throw new TemplateNotFoundError(tenantId, category, lang);
  }

  try {
    // 2. Compile subject
    const subject = hbs.compile(template.subject)(vars);

    // 3. Compile html body
    const rendered = hbs.compile(template.htmlBody)(vars);

    // 4. Sanitize rendered HTML (defense-in-depth)
    const html = sanitizeEmailHtml(rendered);

    // 5. Compile text body
    const text = hbs.compile(template.textBody)(vars);

    return { subject, html, text };
  } catch (err) {
    renderErrorTotal.inc({ category });
    logger.error({ err, category, lang, templateId: String(template.id) }, 'n02: render error');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Preview render (missing vars → highlighted placeholder)
// ---------------------------------------------------------------------------

export interface PreviewResult extends RenderEmailResult {
  missingVars: string[];
}

export function previewRender(
  subject: string,
  htmlBody: string,
  textBody: string,
  sampleVars: Record<string, unknown>,
): PreviewResult {
  const missingVars: string[] = [];

  // Wrap hbs with a proxy that captures missing vars
  const proxyVars = createMissingVarProxy(sampleVars, '', missingVars);

  let compiledSubject: string;
  let compiledHtml: string;
  let compiledText: string;

  try {
    compiledSubject = hbs.compile(subject)(proxyVars);
    compiledHtml = hbs.compile(htmlBody)(proxyVars);
    compiledText = hbs.compile(textBody)(proxyVars);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      subject: `[TEMPLATE ERROR: ${errMsg}]`,
      html: `<p>[TEMPLATE ERROR: ${errMsg}]</p>`,
      text: `[TEMPLATE ERROR: ${errMsg}]`,
      missingVars,
    };
  }

  const sanitizedHtml = sanitizeEmailHtml(compiledHtml);

  return {
    subject: compiledSubject,
    html: sanitizedHtml,
    text: compiledText,
    missingVars: [...new Set(missingVars)],
  };
}

function createMissingVarProxy(
  obj: Record<string, unknown>,
  prefix: string,
  missing: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      result[key] = createMissingVarProxy(val as Record<string, unknown>, path, missing);
    } else {
      result[key] = val;
    }
  }

  // Return a Proxy that intercepts missing property access
  return new Proxy(result, {
    get(target, prop: string | symbol) {
      if (typeof prop === 'string' && !(prop in target)) {
        const fullPath = prefix ? `${prefix}.${prop}` : prop;
        missing.push(fullPath);
        return `[MISSING: ${fullPath}]`;
      }
      return target[prop as string];
    },
  });
}

// ---------------------------------------------------------------------------
// DTO serializer
// ---------------------------------------------------------------------------

function toDto(t: {
  id: bigint;
  tenantId: bigint;
  category: string;
  lang: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  active: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): EmailTemplateDto {
  return {
    id: String(t.id),
    tenantId: String(t.tenantId),
    category: t.category,
    lang: t.lang,
    subject: t.subject,
    htmlBody: t.htmlBody,
    textBody: t.textBody,
    active: t.active,
    version: t.version,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CRUD service functions
// ---------------------------------------------------------------------------

export async function listTemplates(
  prisma: PrismaClient,
  tenantId: bigint,
  opts: { category?: string; lang?: string; active?: boolean | 'all' },
): Promise<{ items: EmailTemplateDto[]; total: number }> {
  const where: Record<string, unknown> = { tenantId };
  if (opts.category) where.category = opts.category;
  if (opts.lang) where.lang = opts.lang;
  if (opts.active !== 'all') {
    where.active = opts.active ?? true;
  }

  const [items, total] = await prisma.$transaction([
    prisma.emailTemplate.findMany({ where, orderBy: [{ category: 'asc' }, { lang: 'asc' }] }),
    prisma.emailTemplate.count({ where }),
  ]);

  return { items: items.map(toDto), total };
}

export async function getTemplate(
  prisma: PrismaClient,
  tenantId: bigint,
  id: bigint,
): Promise<EmailTemplateDto | null> {
  const t = await prisma.emailTemplate.findFirst({ where: { id, tenantId } });
  return t ? toDto(t) : null;
}

export async function createTemplate(
  prisma: PrismaClient,
  input: CreateTemplateInput,
): Promise<EmailTemplateDto> {
  const sanitizedHtml = sanitizeEmailHtml(input.htmlBody);
  const textBody = input.textBody ?? htmlToText(sanitizedHtml);

  const t = await prisma.emailTemplate.create({
    data: {
      tenantId: input.tenantId,
      category: input.category,
      lang: input.lang ?? 'en',
      subject: input.subject,
      htmlBody: sanitizedHtml,
      textBody,
      version: 1,
      active: true,
    },
  });

  return toDto(t);
}

export async function patchTemplate(
  prisma: PrismaClient,
  tenantId: bigint,
  id: bigint,
  body: PatchTemplateInput,
): Promise<EmailTemplateDto | null> {
  const existing = await prisma.emailTemplate.findFirst({ where: { id, tenantId } });
  if (!existing) return null;

  const contentChanged =
    body.subject !== undefined ||
    body.htmlBody !== undefined ||
    body.textBody !== undefined;

  const data: Record<string, unknown> = {};
  let newHtml = existing.htmlBody;
  let newText = existing.textBody;
  let newSubject = existing.subject;

  if (body.subject !== undefined) {
    newSubject = body.subject;
    data.subject = newSubject;
  }
  if (body.htmlBody !== undefined) {
    newHtml = sanitizeEmailHtml(body.htmlBody);
    data.htmlBody = newHtml;
    // Auto-gen text if not explicitly provided
    if (body.textBody === undefined) {
      newText = htmlToText(newHtml);
      data.textBody = newText;
    }
  }
  if (body.textBody !== undefined) {
    newText = body.textBody;
    data.textBody = newText;
  }
  if (body.active !== undefined) {
    data.active = body.active;
  }

  if (contentChanged) {
    // Bump version with snapshot + pruning in a transaction
    const newVersion = existing.version + 1;
    data.version = newVersion;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = await prisma.$transaction(async (tx: any) => {
      // Snapshot current version
      await tx.emailTemplateVersion.create({
        data: {
          tenantId,
          templateId: id,
          version: existing.version,
          subject: existing.subject,
          htmlBody: existing.htmlBody,
          textBody: existing.textBody,
        },
      });

      // Prune to keep at most 10 versions
      const versionCount = await tx.emailTemplateVersion.count({
        where: { templateId: id },
      });
      if (versionCount > 10) {
        const oldest = await tx.emailTemplateVersion.findMany({
          where: { templateId: id },
          orderBy: { version: 'asc' },
          take: versionCount - 10,
          select: { id: true },
        });
        if (oldest.length > 0) {
          await tx.emailTemplateVersion.deleteMany({
            where: { id: { in: oldest.map((v: { id: bigint }) => v.id) } },
          });
        }
      }

      return tx.emailTemplate.update({
        where: { id },
        data,
      });
    });

    return toDto(updated);
  } else {
    const updated = await prisma.emailTemplate.update({
      where: { id },
      data,
    });
    return toDto(updated);
  }
}

export async function deleteTemplate(
  prisma: PrismaClient,
  tenantId: bigint,
  id: bigint,
): Promise<boolean> {
  const existing = await prisma.emailTemplate.findFirst({ where: { id, tenantId } });
  if (!existing) return false;

  await prisma.emailTemplate.update({
    where: { id },
    data: { active: false },
  });
  return true;
}

export async function getTemplateVersions(
  prisma: PrismaClient,
  tenantId: bigint,
  templateId: bigint,
): Promise<EmailTemplateVersionDto[]> {
  const versions = await prisma.emailTemplateVersion.findMany({
    where: { tenantId, templateId },
    orderBy: { version: 'desc' },
    take: 10,
  });

  return versions.map((v: { id: bigint; version: number; subject: string; htmlBody: string; textBody: string; savedAt: Date }) => ({
    id: String(v.id),
    version: v.version,
    subject: v.subject,
    htmlBody: v.htmlBody,
    textBody: v.textBody,
    savedAt: v.savedAt.toISOString(),
  }));
}
