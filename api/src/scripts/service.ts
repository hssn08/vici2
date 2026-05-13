// S03 — Script management service layer.
//
// Business logic for:
//   - CRUD on scripts (per-tenant)
//   - Versioning (bump + prune on update)
//   - Render (interpolation + sanitization)
//   - Agent render endpoint (campaign → active script → render)

import { getPrisma } from "../lib/prisma.js";
import { sanitizeBody } from "./sanitize.js";
import { interpolate, extractVariables } from "./interpolate.js";
import type { LeadContext, AgentContext, CampaignContext, CallContext } from "./interpolate.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_VERSIONS = 10;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface ScriptVariable {
  name: string;
  description?: string;
}

export interface ScriptResponse {
  id: string;
  tenantId: string;
  name: string;
  body: string;
  campaignId: string | null;
  active: boolean;
  version: number;
  variables: ScriptVariable[];
  createdAt: string;
  updatedAt: string;
}

export interface ScriptListResponse {
  data: ScriptResponse[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface ScriptVersionResponse {
  id: string;
  scriptId: string;
  version: number;
  name: string;
  body: string;
  variables: ScriptVariable[];
  savedAt: string;
}

export interface RenderResponse {
  html: string;
  scriptId: string;
  version: number;
}

export interface ScriptCreateInput {
  name: string;
  body: string;
  campaignId?: string | null;
  active?: boolean;
}

export interface ScriptUpdateInput {
  name?: string;
  body?: string;
  campaignId?: string | null;
  active?: boolean;
}

export interface ScriptListQuery {
  page?: number;
  pageSize?: number;
  campaignId?: string;
  active?: boolean;
  search?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toResponse(s: {
  id: bigint;
  tenantId: bigint;
  name: string;
  body: string;
  campaignId: string | null;
  active: boolean;
  version: number;
  variables: unknown;
  createdAt: Date;
  updatedAt: Date;
}): ScriptResponse {
  return {
    id: String(s.id),
    tenantId: String(s.tenantId),
    name: s.name,
    body: s.body,
    campaignId: s.campaignId,
    active: s.active,
    version: s.version,
    variables: Array.isArray(s.variables) ? (s.variables as ScriptVariable[]) : [],
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

function toVersionResponse(v: {
  id: bigint;
  scriptId: bigint;
  version: number;
  name: string;
  body: string;
  variables: unknown;
  savedAt: Date;
}): ScriptVersionResponse {
  return {
    id: String(v.id),
    scriptId: String(v.scriptId),
    version: v.version,
    name: v.name,
    body: v.body,
    variables: Array.isArray(v.variables) ? (v.variables as ScriptVariable[]) : [],
    savedAt: v.savedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listScripts(
  tenantId: number,
  query: ScriptListQuery = {},
): Promise<ScriptListResponse> {
  const db = getPrisma();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));
  const skip = (page - 1) * pageSize;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { tenantId };
  if (query.campaignId !== undefined) where.campaignId = query.campaignId;
  if (query.active !== undefined) where.active = query.active;
  if (query.search) {
    where.name = { contains: query.search };
  }

  const [data, totalCount] = await db.$transaction([
    db.script.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { name: "asc" },
    }),
    db.script.count({ where }),
  ]);

  return {
    data: data.map(toResponse),
    page,
    pageSize,
    totalCount,
    totalPages: Math.ceil(totalCount / pageSize),
  };
}

// ---------------------------------------------------------------------------
// Get one
// ---------------------------------------------------------------------------

export async function getScript(tenantId: number, id: bigint): Promise<ScriptResponse | null> {
  const db = getPrisma();
  const script = await db.script.findFirst({ where: { tenantId, id } });
  return script ? toResponse(script) : null;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createScript(
  tenantId: number,
  input: ScriptCreateInput,
): Promise<ScriptResponse> {
  const db = getPrisma();
  const safeBody = sanitizeBody(input.body);
  const detectedVars = extractVariables(safeBody).map((name) => ({ name }));

  const script = await db.script.create({
    data: {
      tenantId,
      name: input.name,
      body: safeBody,
      campaignId: input.campaignId ?? null,
      active: input.active ?? true,
      version: 1,
      variables: detectedVars,
    },
  });

  return toResponse(script);
}

// ---------------------------------------------------------------------------
// Update (bumps version, saves history, prunes old versions)
// ---------------------------------------------------------------------------

export async function updateScript(
  tenantId: number,
  id: bigint,
  input: ScriptUpdateInput,
): Promise<ScriptResponse | null> {
  const db = getPrisma();

  const existing = await db.script.findFirst({ where: { tenantId, id } });
  if (!existing) return null;

  const bodyChanged = input.body !== undefined && input.body !== existing.body;
  const nameChanged = input.name !== undefined && input.name !== existing.name;
  const bumpVersion = bodyChanged || nameChanged;

  const safeBody =
    input.body !== undefined ? sanitizeBody(input.body) : existing.body;
  const newName = input.name ?? existing.name;
  const detectedVars = extractVariables(safeBody).map((name) => ({ name }));
  const newVersion = bumpVersion ? existing.version + 1 : existing.version;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const script = await db.$transaction(async (tx: any) => {
    // If we bump, save the current as a version snapshot
    if (bumpVersion) {
      await tx.scriptVersion.create({
        data: {
          tenantId,
          scriptId: id,
          version: existing.version,
          name: existing.name,
          body: existing.body,
          variables: Array.isArray(existing.variables) ? existing.variables : [],
        },
      });

      // Prune: keep only the latest MAX_VERSIONS versions
      const versions: Array<{ id: bigint }> = await tx.scriptVersion.findMany({
        where: { scriptId: id },
        orderBy: { version: "desc" },
        select: { id: true },
      });

      if (versions.length > MAX_VERSIONS) {
        const toDelete = versions.slice(MAX_VERSIONS).map((v: { id: bigint }) => v.id);
        await tx.scriptVersion.deleteMany({ where: { id: { in: toDelete } } });
      }
    }

    // Update the script
    return tx.script.update({
      where: { id },
      data: {
        name: newName,
        body: safeBody,
        campaignId: input.campaignId !== undefined ? input.campaignId : existing.campaignId,
        active: input.active !== undefined ? input.active : existing.active,
        version: newVersion,
        variables: detectedVars,
      },
    });
  });

  return toResponse(script);
}

// ---------------------------------------------------------------------------
// Delete (soft — sets active = false)
// ---------------------------------------------------------------------------

export async function deleteScript(
  tenantId: number,
  id: bigint,
): Promise<boolean> {
  const db = getPrisma();
  const existing = await db.script.findFirst({ where: { tenantId, id } });
  if (!existing) return false;

  await db.script.update({ where: { id }, data: { active: false } });
  return true;
}

// ---------------------------------------------------------------------------
// List versions
// ---------------------------------------------------------------------------

export async function listScriptVersions(
  tenantId: number,
  scriptId: bigint,
): Promise<ScriptVersionResponse[]> {
  const db = getPrisma();
  // Verify ownership
  const exists = await db.script.findFirst({ where: { tenantId, id: scriptId } });
  if (!exists) return [];

  const versions = await db.scriptVersion.findMany({
    where: { tenantId, scriptId },
    orderBy: { version: "desc" },
    take: MAX_VERSIONS,
  });

  return versions.map(toVersionResponse);
}

// ---------------------------------------------------------------------------
// Get specific version
// ---------------------------------------------------------------------------

export async function getScriptVersion(
  tenantId: number,
  scriptId: bigint,
  version: number,
): Promise<ScriptVersionResponse | null> {
  const db = getPrisma();
  // Verify ownership
  const exists = await db.script.findFirst({ where: { tenantId, id: scriptId } });
  if (!exists) return null;

  const sv = await db.scriptVersion.findFirst({
    where: { tenantId, scriptId, version },
  });
  return sv ? toVersionResponse(sv) : null;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface RenderInput {
  leadId?: bigint | null;
  callUuid?: string | null;
  callStartedAt?: string | null;
  /** Agent context from req.auth */
  agentName?: string;
  mode?: "render" | "preview";
}

export async function renderScript(
  tenantId: number,
  scriptId: bigint,
  input: RenderInput = {},
): Promise<RenderResponse | null> {
  const db = getPrisma();

  const script = await db.script.findFirst({
    where: { tenantId, id: scriptId, active: true },
  });
  if (!script) return null;

  let leadCtx: LeadContext = {};
  if (input.leadId) {
    const lead = await db.lead.findFirst({
      where: { tenantId, id: input.leadId },
      select: {
        firstName: true,
        lastName: true,
        phoneE164: true,
        email: true,
        city: true,
        state: true,
        customData: true,
      },
    });
    if (lead) {
      leadCtx = {
        firstName: lead.firstName,
        lastName: lead.lastName,
        phoneE164: lead.phoneE164,
        email: lead.email,
        city: lead.city,
        state: lead.state,
        customData: lead.customData as Record<string, unknown>,
      };
    }
  }

  // Campaign info from the script's campaign relation
  let campaignCtx: CampaignContext = { name: "" };
  if (script.campaignId) {
    const campaign = await db.campaign.findFirst({
      where: { tenantId, id: script.campaignId },
      select: { name: true },
    });
    if (campaign) campaignCtx = { name: campaign.name };
  }

  const agentCtx: AgentContext = { name: input.agentName ?? "" };
  const callCtx: CallContext = { startedAt: input.callStartedAt };

  const rendered = interpolate(
    script.body,
    leadCtx,
    agentCtx,
    campaignCtx,
    callCtx,
    { mode: input.mode ?? "render" },
  );

  // Belt-and-suspenders sanitization (body already sanitized at save time)
  const { sanitizeBody } = await import("./sanitize.js");
  const html = sanitizeBody(rendered);

  return {
    html,
    scriptId: String(script.id),
    version: script.version,
  };
}

// ---------------------------------------------------------------------------
// Agent render: find active script for campaign + lead
// ---------------------------------------------------------------------------

export async function renderScriptForAgent(
  tenantId: number,
  campaignId: string,
  opts: {
    leadId?: bigint | null;
    callUuid?: string | null;
    callStartedAt?: string | null;
    agentName?: string;
  } = {},
): Promise<RenderResponse | null> {
  const db = getPrisma();

  // Find the active script linked to this campaign
  const script = await db.script.findFirst({
    where: { tenantId, campaignId, active: true },
    orderBy: { updatedAt: "desc" },
  });
  if (!script) return null;

  return renderScript(tenantId, script.id, {
    leadId: opts.leadId,
    callUuid: opts.callUuid,
    callStartedAt: opts.callStartedAt,
    agentName: opts.agentName,
    mode: "render",
  });
}
