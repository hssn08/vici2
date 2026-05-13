// I02 — IVR dialplan renderer.
//
// Renders IVR trees as FreeSWITCH dialplan XML files.
// Writes atomically (tmp → rename) and calls bgapi reloadxml.
//
// PLAN §7.1–§7.3

import fs from "node:fs/promises";
import path from "node:path";
import { getPrisma } from "../../lib/prisma.js";
import { validateIvrGraph } from "./IvrValidator.js";
import { buildDefaultContextXml, buildPublicContextXml } from "./XmlBuilder.js";
import type { BuilderIvr, BuilderDid, BuilderNode, BuilderEdge, PromptVariant } from "./XmlBuilder.js";
import type { IvrNodeType } from "@vici2/types";
import { env } from "../../lib/env.js";

// ─── Config ──────────────────────────────────────────────────────────────────

// FS config volume mount paths — configurable via env
function getDialplanDefaultDir(): string {
  return (env as Record<string, unknown>)["fsDialplanDefaultDir"] as string
    ?? process.env.FS_DIALPLAN_DEFAULT_DIR
    ?? "/etc/freeswitch/dialplan/default";
}

function getDialplanPublicDir(): string {
  return (env as Record<string, unknown>)["fsDialplanPublicDir"] as string
    ?? process.env.FS_DIALPLAN_PUBLIC_DIR
    ?? "/etc/freeswitch/dialplan/public";
}

function getSoundsIvrDir(): string {
  return process.env.FS_SOUNDS_IVR_DIR ?? "/var/lib/freeswitch/sounds/ivr";
}

// ─── ESL reloadxml ────────────────────────────────────────────────────────────

async function reloadXml(): Promise<void> {
  // Fire bgapi reloadxml via Valkey pub/sub (same pattern as ingroup renderer).
  // The dialer's ESL worker subscribes and proxies to FS.
  const { getRedis } = await import("../../lib/redis.js");
  const rdb = getRedis();
  await rdb.publish("vici2:freeswitch:reloadxml", "1");
}

// ─── Atomic write ─────────────────────────────────────────────────────────────

async function writeXmlAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  // Write to a tmp file in the same directory, then rename (atomic on same FS)
  const tmpPath = path.join(dir, `.tmp_${path.basename(filePath)}_${Date.now()}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, content, "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // Clean up tmp on failure
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

// ─── Prompt path resolver ─────────────────────────────────────────────────────

function localPromptPath(
  tenantId: bigint,
  ivrId: bigint,
  nodeId: bigint,
  lang: string,
): string {
  const soundsDir = getSoundsIvrDir();
  return path.join(soundsDir, `t${tenantId}`, String(ivrId), `${nodeId}_${lang}.wav`);
}

// ─── Prisma type helpers ──────────────────────────────────────────────────────

interface NodeWithPrompts {
  id: bigint;
  tenantId: bigint;
  ivrId: bigint;
  name: string;
  nodeType: string;
  collectMin: number;
  collectMax: number;
  collectTerminators: string;
  timeoutMs: number;
  invalidMax: number;
  actionTarget: string | null;
  positionX: number;
  positionY: number;
  prompts: Array<{
    id: bigint;
    lang: string;
    fileUri: string;
    fileSizeBytes: number | null;
    durationMs: number | null;
  }>;
}

interface EdgeRaw {
  id: bigint;
  fromNodeId: bigint;
  onInput: string;
  toNodeId: bigint | null;
  label: string | null;
  sortOrder: number;
}

interface IvrWithAll {
  id: bigint;
  tenantId: bigint;
  name: string;
  entryNodeId: bigint | null;
  active: boolean;
  nodes: NodeWithPrompts[];
  // edges fetched separately
}

// ─── Main renderer ────────────────────────────────────────────────────────────

export class IvrRenderer {
  private prisma = getPrisma();

  /** Render + write + reload for a given IVR ID. */
  async render(ivrId: bigint): Promise<void> {
    const ivr = await this.loadIvr(ivrId);
    const edges = await this.loadEdges(ivrId);

    // Validate
    const graph = {
      entryNodeId: ivr.entryNodeId,
      nodes: ivr.nodes.map((n) => ({
        id: n.id,
        nodeType: n.nodeType as IvrNodeType,
      })),
      edges: edges.map((e) => ({
        fromNodeId: e.fromNodeId,
        onInput: e.onInput,
        toNodeId: e.toNodeId,
      })),
    };
    const { maxDepth } = validateIvrGraph(graph);

    // Update cached depth
    await this.prisma.ivr.update({
      where: { id: ivrId },
      data: { maxDepthValidated: maxDepth },
    });

    if (!ivr.entryNodeId) {
      // No entry node yet — nothing to render
      return;
    }

    // Build XML
    const builderIvr = this.toBuilderIvr(ivr, edges);
    const defaultXml = buildDefaultContextXml(builderIvr);

    // Write default context file
    const defaultPath = path.join(
      getDialplanDefaultDir(),
      `70_ivr_${ivrId}.xml`,
    );
    await writeXmlAtomic(defaultPath, defaultXml);

    // Write public context DID files
    const dids = await this.loadDids(ivrId, ivr.tenantId);
    for (const did of dids) {
      const publicXml = buildPublicContextXml(did, builderIvr);
      const publicPath = path.join(
        getDialplanPublicDir(),
        `10_did_${did.e164Digits}.xml`,
      );
      await writeXmlAtomic(publicPath, publicXml);
    }

    // Reload FS dialplan
    await reloadXml();
  }

  /** Remove dialplan files for a deleted/deactivated IVR. */
  async remove(ivrId: bigint, tenantId: bigint): Promise<void> {
    const defaultPath = path.join(
      getDialplanDefaultDir(),
      `70_ivr_${ivrId}.xml`,
    );
    await fs.unlink(defaultPath).catch(() => undefined);

    // Remove DID public files for this IVR
    const dids = await this.loadDids(ivrId, tenantId);
    for (const did of dids) {
      const publicPath = path.join(
        getDialplanPublicDir(),
        `10_did_${did.e164Digits}.xml`,
      );
      await fs.unlink(publicPath).catch(() => undefined);
    }

    await reloadXml();
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async loadIvr(ivrId: bigint): Promise<IvrWithAll> {
    const ivr = await this.prisma.ivr.findUnique({
      where: { id: ivrId },
      include: {
        nodes: {
          include: { prompts: true },
        },
      },
    });
    if (!ivr) throw new Error(`IVR ${ivrId} not found`);
    return ivr as unknown as IvrWithAll;
  }

  private async loadEdges(ivrId: bigint): Promise<EdgeRaw[]> {
    const edges = await this.prisma.ivrEdge.findMany({
      where: { ivrId },
    });
    return edges as unknown as EdgeRaw[];
  }

  private async loadDids(
    ivrId: bigint,
    tenantId: bigint,
  ): Promise<BuilderDid[]> {
    const dids = await (this.prisma as unknown as Record<string, unknown>).didNumber
      ? (await (this.prisma as unknown as {
          didNumber: { findMany: (q: unknown) => Promise<unknown[]> }
        }).didNumber.findMany({
          where: { tenantId, routeKind: "ivr", routeTarget: String(ivrId) },
          select: {
            e164: true,
            defaultLang: true,
            ivrTimeoutSec: true,
          },
        })) as Array<{ e164: string; defaultLang: string; ivrTimeoutSec: number; recordingDisclosureAudio?: string | null }>
      : [];

    return dids.map((d) => ({
      e164: d.e164,
      e164Digits: d.e164.replace(/^\+/, ""),
      defaultLang: d.defaultLang ?? "en",
      ivrTimeoutSec: d.ivrTimeoutSec ?? 300,
      ivrId,
      recordingDisclosureAudio: d.recordingDisclosureAudio ?? null,
    }));
  }

  private toBuilderIvr(ivr: IvrWithAll, edges: EdgeRaw[]): BuilderIvr {
    const nodes: BuilderNode[] = ivr.nodes.map((n) => {
      const prompts: PromptVariant[] = n.prompts.map((p) => ({
        lang: p.lang,
        localPath: localPromptPath(ivr.tenantId, ivr.id, n.id, p.lang),
      }));

      return {
        id: n.id,
        nodeType: n.nodeType as IvrNodeType,
        name: n.name,
        collectMin: n.collectMin,
        collectMax: n.collectMax,
        collectTerminators: n.collectTerminators,
        timeoutMs: n.timeoutMs,
        invalidMax: n.invalidMax,
        actionTarget: n.actionTarget,
        prompts,
      };
    });

    const builderEdges: BuilderEdge[] = edges.map((e) => ({
      fromNodeId: e.fromNodeId,
      onInput: e.onInput,
      toNodeId: e.toNodeId,
      label: e.label,
      sortOrder: e.sortOrder,
    }));

    return {
      id: ivr.id,
      entryNodeId: ivr.entryNodeId!,
      nodes,
      edges: builderEdges,
    };
  }
}

// Singleton
let _renderer: IvrRenderer | null = null;
export function getIvrRenderer(): IvrRenderer {
  if (!_renderer) _renderer = new IvrRenderer();
  return _renderer;
}

// For tests
export function setIvrRendererForTests(r: IvrRenderer | null): void {
  _renderer = r;
}
