// M07 — Script service layer.
//
// Implements CRUD, version history (max 10 per script), and script rendering
// with {{double_brace}} Handlebars-compatible token substitution.

import { getPrisma } from "../../../lib/prisma.js";
import { audit } from "../../../auth/audit.js";
import type {
  ScriptCreateInput,
  ScriptUpdateInput,
  ScriptListQuery,
  ScriptResponse,
  ScriptListResponse,
  ScriptVersionResponse,
  ScriptRenderInput,
  ScriptRenderResponse,
  ScriptVariable,
} from "./schema.js";

// Maximum version history entries to keep per script
const MAX_VERSIONS = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip HTML tags for body preview. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** Auto-detect {{token}} placeholders in script body. */
function detectVariables(body: string): ScriptVariable[] {
  const found = new Set<string>();
  // Match {{token}} — Handlebars-compatible double-brace syntax
  for (const m of body.matchAll(/\{\{([a-z][a-z0-9_.]*)\}\}/gi)) {
    if (m[1]) found.add(m[1].toLowerCase());
  }
  return [...found].sort().map((name) => ({ name }));
}

/** Render script body: replace {{token}} with values, fallback to [token]. */
function renderBody(body: string, context: Record<string, string>): string {
  // First strip span-wrapped chip tokens if stored as HTML
  let rendered = body.replace(
    /<span[^>]*data-token[^>]*data-value="([^"]+)"[^>]*>.*?<\/span>/gs,
    (_match, value: string) => value,
  );
  // Substitute {{token}} with values
  rendered = rendered.replace(/\{\{([a-z][a-z0-9_.]*)\}\}/gi, (_match, key: string) => {
    const lower = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(context, lower)
      ? String(context[lower])
      : `[${key}]`;
  });
  return rendered;
}

/** Build context map from sample data and agent/campaign info. */
function buildContext(input: ScriptRenderInput): Record<string, string> {
  const ctx: Record<string, string> = {};
  const s = input.sampleData ?? {};
  if (s.first_name) ctx["lead.first_name"] = s.first_name;
  if (s.last_name) ctx["lead.last_name"] = s.last_name;
  if (s.phone) ctx["lead.phone"] = s.phone;
  if (s.email) ctx["lead.email"] = s.email;
  if (s.city) ctx["lead.city"] = s.city;
  if (s.state) ctx["lead.state"] = s.state;
  if (s.custom) {
    for (const [k, v] of Object.entries(s.custom as Record<string, string>)) {
      ctx[`lead.custom.${k}`] = String(v);
    }
  }
  if (input.agentName) ctx["agent.name"] = input.agentName;
  if (input.campaignName) ctx["campaign.name"] = input.campaignName;
  return ctx;
}

// ---------------------------------------------------------------------------
// Response mapper
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toScriptResponse(row: any, usedByCampaignCount = 0): ScriptResponse {
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    name: row.name,
    body: row.body,
    campaignId: row.campaignId ?? null,
    active: row.active,
    version: row.version,
    variables: Array.isArray(row.variables) ? (row.variables as ScriptVariable[]) : [],
    usedByCampaignCount,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toVersionResponse(row: any): ScriptVersionResponse {
  return {
    id: String(row.id),
    scriptId: String(row.scriptId),
    version: row.version,
    name: row.name,
    bodyPreview: stripHtml(row.body).slice(0, 120),
    savedAt: row.savedAt instanceof Date ? row.savedAt.toISOString() : row.savedAt,
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listScripts(
  tenantId: number,
  query: ScriptListQuery,
): Promise<ScriptListResponse> {
  const db = getPrisma();
  const { page, pageSize, campaignId, search, active } = query;
  const skip = (page - 1) * pageSize;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { tenantId: BigInt(tenantId) };

  if (campaignId === "__GLOBAL__") {
    where.campaignId = null;
  } else if (campaignId) {
    where.campaignId = campaignId;
  }

  if (active !== "all") where.active = active === "true";
  if (search) {
    where.name = { contains: search };
  }

  const [rows, totalCount] = await Promise.all([
    db.script.findMany({ where, skip, take: pageSize, orderBy: { name: "asc" } }),
    db.script.count({ where }),
  ]);

  // Compute "used by N campaigns" for each script
  const scriptIds = rows.map((r) => r.id);
  const campaignCounts: Record<string, number> = {};
  if (scriptIds.length > 0) {
    const counts = await db.campaign.groupBy({
      by: ["scriptId"],
      where: { scriptId: { in: scriptIds } },
      _count: { scriptId: true },
    });
    for (const c of counts) {
      if (c.scriptId !== null) {
        campaignCounts[String(c.scriptId)] = c._count.scriptId;
      }
    }
  }

  return {
    data: rows.map((r) => toScriptResponse(r, campaignCounts[String(r.id)] ?? 0)),
    page,
    pageSize,
    totalCount,
    totalPages: Math.ceil(totalCount / pageSize),
  };
}

// ---------------------------------------------------------------------------
// Get one
// ---------------------------------------------------------------------------

export async function getScript(
  tenantId: number,
  id: bigint,
): Promise<ScriptResponse | null> {
  const db = getPrisma();
  const row = await db.script.findFirst({
    where: { id, tenantId: BigInt(tenantId) },
  });
  if (!row) return null;
  const usedCount = await db.campaign.count({ where: { scriptId: id } });
  return toScriptResponse(row, usedCount);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createScript(
  tenantId: number,
  actorUserId: number,
  data: ScriptCreateInput,
): Promise<ScriptResponse> {
  const db = getPrisma();
  const variables = data.variables.length > 0 ? data.variables : detectVariables(data.body);

  const row = await db.$transaction(async (tx) => {
    const created = await tx.script.create({
      data: {
        tenantId: BigInt(tenantId),
        name: data.name,
        body: data.body,
        campaignId: data.campaignId,
        active: data.active,
        version: 1,
        variables: variables as never,
      },
    });
    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "script.created",
      tenantId: BigInt(tenantId),
      entityType: "script",
      entityId: String(created.id),
      afterJson: { name: created.name, version: created.version },
    });
    return created;
  });
  return toScriptResponse(row, 0);
}

// ---------------------------------------------------------------------------
// Update (bumps version, saves ScriptVersion, prunes to MAX_VERSIONS)
// ---------------------------------------------------------------------------

export async function updateScript(
  tenantId: number,
  actorUserId: number,
  id: bigint,
  data: ScriptUpdateInput,
): Promise<ScriptResponse | null> {
  const db = getPrisma();

  const existing = await db.script.findFirst({
    where: { id, tenantId: BigInt(tenantId) },
  });
  if (!existing) return null;

  const newVariables =
    data.variables !== undefined
      ? data.variables
      : data.body !== undefined
      ? detectVariables(data.body)
      : (existing.variables as ScriptVariable[]);

  const row = await db.$transaction(async (tx) => {
    // Save current state as a version snapshot
    await tx.scriptVersion.create({
      data: {
        tenantId: BigInt(tenantId),
        scriptId: id,
        version: existing.version,
        name: existing.name,
        body: existing.body,
        variables: existing.variables as never,
        savedAt: new Date(),
      },
    });

    // Update the script
    const updated = await tx.script.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.body !== undefined && { body: data.body }),
        ...(data.campaignId !== undefined && { campaignId: data.campaignId }),
        ...(data.active !== undefined && { active: data.active }),
        version: { increment: 1 },
        variables: newVariables as never,
      },
    });

    // Prune oldest versions beyond MAX_VERSIONS
    const allVersions = await tx.scriptVersion.findMany({
      where: { scriptId: id },
      orderBy: { version: "desc" },
      select: { id: true },
    });
    if (allVersions.length > MAX_VERSIONS) {
      const toDelete = allVersions.slice(MAX_VERSIONS).map((v) => v.id);
      await tx.scriptVersion.deleteMany({ where: { id: { in: toDelete } } });
    }

    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "script.updated",
      tenantId: BigInt(tenantId),
      entityType: "script",
      entityId: String(id),
      beforeJson: { name: existing.name, version: existing.version },
      afterJson: { name: updated.name, version: updated.version },
    });
    return updated;
  });

  const usedCount = await db.campaign.count({ where: { scriptId: id } });
  return toScriptResponse(row, usedCount);
}

// ---------------------------------------------------------------------------
// Soft-delete (active = false)
// ---------------------------------------------------------------------------

export async function deleteScript(
  tenantId: number,
  actorUserId: number,
  id: bigint,
): Promise<boolean> {
  const db = getPrisma();
  const existing = await db.script.findFirst({
    where: { id, tenantId: BigInt(tenantId) },
  });
  if (!existing) return false;

  await db.$transaction(async (tx) => {
    await tx.script.update({ where: { id }, data: { active: false } });
    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "script.deleted",
      tenantId: BigInt(tenantId),
      entityType: "script",
      entityId: String(id),
      beforeJson: { name: existing.name, active: existing.active },
    });
  });
  return true;
}

// ---------------------------------------------------------------------------
// List version history (max 10)
// ---------------------------------------------------------------------------

export async function listScriptVersions(
  tenantId: number,
  scriptId: bigint,
): Promise<ScriptVersionResponse[] | null> {
  const db = getPrisma();
  const script = await db.script.findFirst({
    where: { id: scriptId, tenantId: BigInt(tenantId) },
    select: { id: true },
  });
  if (!script) return null;

  const versions = await db.scriptVersion.findMany({
    where: { scriptId, tenantId: BigInt(tenantId) },
    orderBy: { version: "desc" },
    take: MAX_VERSIONS,
  });
  return versions.map(toVersionResponse);
}

// ---------------------------------------------------------------------------
// Restore a version (creates new version bump)
// ---------------------------------------------------------------------------

export async function restoreScriptVersion(
  tenantId: number,
  actorUserId: number,
  scriptId: bigint,
  versionNumber: number,
): Promise<ScriptResponse | null> {
  const db = getPrisma();

  const existing = await db.script.findFirst({
    where: { id: scriptId, tenantId: BigInt(tenantId) },
  });
  if (!existing) return null;

  const versionRow = await db.scriptVersion.findUnique({
    where: { scriptId_version: { scriptId, version: versionNumber } },
  });
  if (!versionRow) return null;

  const row = await db.$transaction(async (tx) => {
    // Save current state as a version snapshot first
    await tx.scriptVersion.create({
      data: {
        tenantId: BigInt(tenantId),
        scriptId,
        version: existing.version,
        name: existing.name,
        body: existing.body,
        variables: existing.variables as never,
        savedAt: new Date(),
      },
    });

    // Restore the script body/name from the version
    const restored = await tx.script.update({
      where: { id: scriptId },
      data: {
        name: versionRow.name,
        body: versionRow.body,
        variables: versionRow.variables as never,
        version: { increment: 1 },
      },
    });

    // Prune versions beyond MAX_VERSIONS
    const allVersions = await tx.scriptVersion.findMany({
      where: { scriptId },
      orderBy: { version: "desc" },
      select: { id: true },
    });
    if (allVersions.length > MAX_VERSIONS) {
      const toDelete = allVersions.slice(MAX_VERSIONS).map((v) => v.id);
      await tx.scriptVersion.deleteMany({ where: { id: { in: toDelete } } });
    }

    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "script.restored",
      tenantId: BigInt(tenantId),
      entityType: "script",
      entityId: String(scriptId),
      beforeJson: { version: existing.version },
      afterJson: { restoredFrom: versionNumber, newVersion: restored.version },
    });
    return restored;
  });

  const usedCount = await db.campaign.count({ where: { scriptId } });
  return toScriptResponse(row, usedCount);
}

// ---------------------------------------------------------------------------
// Render endpoint
// ---------------------------------------------------------------------------

export async function renderScript(
  tenantId: number,
  scriptId: bigint,
  input: ScriptRenderInput,
): Promise<ScriptRenderResponse | null> {
  const db = getPrisma();
  const script = await db.script.findFirst({
    where: { id: scriptId, tenantId: BigInt(tenantId) },
  });
  if (!script) return null;

  const context = buildContext(input);
  const html = renderBody(script.body, context);

  return {
    scriptId: String(scriptId),
    version: script.version,
    html,
  };
}
