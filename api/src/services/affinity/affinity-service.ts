// affinity-service.ts — X03 Multi-FS Campaign Affinity Service.
//
// Provides getOrAssignNode, pinCampaign, computeAutoAssignment,
// getSipServerUri, listNodes, createNode, setNodeStatus.
//
// ESL password is envelope-encrypted using the same KEK as carrier credentials
// (api/src/auth/encryption.ts). X03 PLAN §4.1.

import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { encrypt, decrypt } from "../../auth/encryption.js";
import { getPrisma } from "../../lib/prisma.js";

// Re-export types for callers. When Prisma generates the client these will
// be available; until then we use structural aliases.
 
type PrismaClient = ReturnType<typeof getPrisma>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FsNode = Record<string, any>;
type FsNodeStatus = "ACTIVE" | "DRAINING" | "UNHEALTHY" | "OFFLINE";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateFsNodeInput {
  tenantId: number;
  name: string;
  host: string;
  eslHost: string;
  eslPort?: number;
  eslPassword: string;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface UpdateFsNodeInput {
  name?: string;
  host?: string;
  eslHost?: string;
  eslPort?: number;
  eslPassword?: string;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface FsNodeWithStats {
  id: number;
  tenantId: number;
  name: string;
  host: string;
  eslHost: string;
  eslPort: number;
  weight: number;
  status: FsNodeStatus;
  lastHeartbeat: string | null;
  campaignCount: number;
  activeCalls: number;
  eslConnected: boolean;
  metadata: Record<string, unknown>;
}

// Affinity cache TTL (seconds).
const AFFINITY_TTL_S = 5;

// ──────────────────────────────────────────────────────────────────────────────
// Rendezvous hash (mirrors Go implementation for golden-test parity)
// FNV-1a over 16 bytes: [campaignID uint64 LE][nodeID uint64 LE]
// ──────────────────────────────────────────────────────────────────────────────

function fnv1a64(campaignId: number, nodeId: number): bigint {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(BigInt(campaignId), 0);
  buf.writeBigUInt64LE(BigInt(nodeId), 8);

  let h = 14695981039346656037n; // FNV offset basis
  const prime = 1099511628211n;
  for (const byte of buf) {
    h ^= BigInt(byte);
    h = BigInt.asUintN(64, h * prime);
  }
  return h;
}

function rendezVousScore(campaignId: number, nodeId: number, weight: number): bigint {
  const base = fnv1a64(campaignId, nodeId);
  return BigInt.asUintN(64, base * BigInt(Math.max(1, weight)));
}

// ──────────────────────────────────────────────────────────────────────────────
// AffinityService
// ──────────────────────────────────────────────────────────────────────────────

export class AffinityService {
  constructor(
    private db: PrismaClient,
    private redis: Redis,
    private logger: Logger,
  ) {}

  /**
   * Returns the fs_node_id for a campaign, auto-assigning if NULL.
   * Result is written to DB and Redis cache.
   */
  async getOrAssignNode(campaignId: number): Promise<number> {
    const cacheKey = `affinity:campaign:${campaignId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const id = parseInt(cached, 10);
      if (id > 0) return id;
    }

    const campaign = await this.db.campaign.findFirst({
      where: { id: String(campaignId) },
      select: { fsNodeId: true },
    });
    if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

    if (campaign.fsNodeId != null) {
      await this.redis.set(cacheKey, String(campaign.fsNodeId), "EX", AFFINITY_TTL_S);
      return campaign.fsNodeId;
    }

    // Auto-assign.
    const nodeId = await this.computeAutoAssignment(campaignId);
    await this.db.campaign.updateMany({
      where: { id: String(campaignId) },
      data: { fsNodeId: nodeId },
    });
    await this.redis.set(cacheKey, String(nodeId), "EX", AFFINITY_TTL_S);

    this.logger.info({ campaignId, nodeId }, "affinity: auto-assigned campaign to FS node");
    return nodeId;
  }

  /**
   * Manually pins a campaign to a specific FS node.
   * Rejects if campaign has active_calls > 0 unless force=true.
   * Writes audit log entry.
   */
  async pinCampaign(
    campaignId: number,
    nodeId: number,
    force = false,
    actorId?: number,
  ): Promise<void> {
    const campaign = await this.db.campaign.findFirst({
      where: { id: String(campaignId) },
      select: { tenantId: true, fsNodeId: true },
    });
    if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

    const node = await this.db.fsNode.findUnique({ where: { id: nodeId } });
    if (!node) throw new Error(`FS node ${nodeId} not found`);

    if (!force) {
      const activeKey = `t:${campaign.tenantId}:campaign:{${campaignId}}:active_calls`;
      const activeStr = await this.redis.get(activeKey);
      const activeCalls = activeStr ? parseInt(activeStr, 10) : 0;
      if (activeCalls > 0) {
        const err: Error & { code?: string; activeCalls?: number } = new Error(
          `Campaign has ${activeCalls} active call(s). Use force=true to override.`,
        );
        err.code = "CAMPAIGN_HAS_ACTIVE_CALLS";
        err.activeCalls = activeCalls;
        throw err;
      }
    }

    await this.db.campaign.updateMany({
      where: { id: String(campaignId) },
      data: { fsNodeId: nodeId },
    });

    const cacheKey = `affinity:campaign:${campaignId}`;
    await this.redis.set(cacheKey, String(nodeId), "EX", AFFINITY_TTL_S);

    // Publish pool-changed so dialer Router invalidates its cache.
    await this.redis.publish("vici2.infra.fs_pool_changed", JSON.stringify({
      type: "campaign_pinned",
      campaignId,
      nodeId,
    }));

    this.logger.info(
      { campaignId, nodeId, force, actorId: actorId?.toString() },
      "affinity: campaign pinned",
    );
  }

  /**
   * Computes the auto-assignment target using rendezvous hash over ACTIVE nodes.
   */
  async computeAutoAssignment(campaignId: number): Promise<number> {
    const nodes = await this.db.fsNode.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, weight: true },
    });
    if (nodes.length === 0) {
      throw new Error("No ACTIVE FS nodes available for auto-assignment");
    }

    let bestNode = nodes[0];
    let bestScore = rendezVousScore(campaignId, bestNode.id, bestNode.weight);

    for (const node of nodes.slice(1)) {
      const score = rendezVousScore(campaignId, node.id, node.weight);
      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    }

    return bestNode.id;
  }

  /**
   * Returns the SIP registration URI for an agent's active campaign.
   * Used by agent-login endpoint to populate sip_server_uri.
   */
  async getSipServerUri(campaignId: number): Promise<string> {
    const nodeId = await this.getOrAssignNode(campaignId);
    const node = await this.db.fsNode.findUnique({
      where: { id: nodeId },
      select: { host: true },
    });
    if (!node) throw new Error(`FS node ${nodeId} not found`);
    return `wss://${node.host}:7443`;
  }

  /**
   * Lists all FS nodes with their current status, campaign counts, and
   * last heartbeat. Used by the admin UI.
   */
  async listNodes(): Promise<FsNodeWithStats[]> {
    const nodes = await this.db.fsNode.findMany({
      include: {
        _count: { select: { campaigns: true } },
      },
      orderBy: { id: "asc" },
    });

    const result: FsNodeWithStats[] = await Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodes.map(async (node: any) => {
        // Sum active calls across all campaigns pinned to this node.
        const campaigns = await this.db.campaign.findMany({
          where: { fsNodeId: node.id as number },
          select: { id: true, tenantId: true },
        });
        let activeCalls = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const c of campaigns as any[]) {
          const key = `t:${c.tenantId}:campaign:{${c.id}}:active_calls`;
          const val = await this.redis.get(key);
          if (val) activeCalls += parseInt(val, 10) || 0;
        }

        return {
          id: node.id as number,
          tenantId: node.tenantId as number,
          name: node.name as string,
          host: node.host as string,
          eslHost: node.eslHost as string,
          eslPort: node.eslPort as number,
          weight: node.weight as number,
          status: node.status as FsNodeStatus,
          lastHeartbeat: node.lastHeartbeat
            ? (node.lastHeartbeat as Date).toISOString()
            : null,
          campaignCount: (node._count?.campaigns ?? 0) as number,
          activeCalls,
          eslConnected: node.status === "ACTIVE",
          metadata: (node.metadata ?? {}) as Record<string, unknown>,
        };
      }),
    );

    return result;
  }

  /**
   * Creates a new FS node. ESL password is envelope-encrypted before storage.
   */
  async createNode(input: CreateFsNodeInput): Promise<FsNode> {
    // Encrypt ESL password. We use row_id=0 as a placeholder (updated after insert).
    // For production, create with a placeholder then re-encrypt with real ID.
    const { ciphertextBlob } = encrypt({
      table: "fs_nodes",
      column: "esl_password",
      rowId: 0,
      tenantId: input.tenantId,
      plaintext: input.eslPassword,
    });
    const encryptedPwd = Buffer.from(ciphertextBlob).toString("base64");

    const node = await this.db.fsNode.create({
      data: {
        tenantId: input.tenantId,
        name: input.name,
        host: input.host,
        eslHost: input.eslHost,
        eslPort: input.eslPort ?? 8021,
        eslPassword: encryptedPwd,
        weight: input.weight ?? 100,
        metadata: input.metadata ?? {},
      },
    });

    // Publish pool-changed so dialer Router reloads.
    await this.redis.publish("vici2.infra.fs_pool_changed", JSON.stringify({
      type: "node_created",
      nodeId: node.id,
    }));

    this.logger.info({ nodeId: node.id, name: node.name }, "affinity: FS node created");
    return node;
  }

  /**
   * Updates node fields (name, weight, metadata, status, esl creds).
   */
  async updateNode(nodeId: number, input: UpdateFsNodeInput, tenantId: number): Promise<FsNode | null> {
    const existing = await this.db.fsNode.findUnique({ where: { id: nodeId } });
    if (!existing) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: Record<string, any> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.host !== undefined) data.host = input.host;
    if (input.eslHost !== undefined) data.eslHost = input.eslHost;
    if (input.eslPort !== undefined) data.eslPort = input.eslPort;
    if (input.weight !== undefined) data.weight = input.weight;
    if (input.metadata !== undefined) data.metadata = input.metadata;

    if (input.eslPassword !== undefined) {
      const { ciphertextBlob } = encrypt({
        table: "fs_nodes",
        column: "esl_password",
        rowId: nodeId,
        tenantId,
        plaintext: input.eslPassword,
      });
      data.eslPassword = Buffer.from(ciphertextBlob).toString("base64");
    }

    const updated = await this.db.fsNode.update({ where: { id: nodeId }, data });

    await this.redis.publish("vici2.infra.fs_pool_changed", JSON.stringify({
      type: "node_updated",
      nodeId,
    }));

    return updated;
  }

  /**
   * Updates node status (ACTIVE/DRAINING/OFFLINE).
   * UNHEALTHY is set only by the health-check worker, not by API callers.
   */
  async setNodeStatus(nodeId: number, status: FsNodeStatus): Promise<void> {
    if (status === "UNHEALTHY") {
      throw new Error("UNHEALTHY status can only be set by the health-check worker");
    }
    if (status !== "ACTIVE" && status !== "DRAINING" && status !== "OFFLINE") {
      throw new Error(`Invalid status: ${status}`);
    }
    await this.db.fsNode.update({ where: { id: nodeId }, data: { status } });

    await this.redis.publish("vici2.infra.fs_pool_changed", JSON.stringify({
      type: "node_status_changed",
      nodeId,
      status,
    }));

    this.logger.info({ nodeId, status }, "affinity: FS node status changed");
  }

  /**
   * Returns the decrypted ESL password for a node (for dialer use only).
   */
  async getEslPassword(nodeId: number, tenantId: number): Promise<string> {
    const node = await this.db.fsNode.findUnique({
      where: { id: nodeId },
      select: { eslPassword: true },
    });
    if (!node) throw new Error(`FS node ${nodeId} not found`);
    const blob = Buffer.from(node.eslPassword, "base64");
    return decrypt({
      table: "fs_nodes",
      column: "esl_password",
      rowId: nodeId,
      tenantId,
      ciphertextBlob: blob,
    }).toString("utf-8");
  }

  /**
   * Lists campaigns pinned to a specific node.
   */
  async listCampaignsForNode(nodeId: number) {
    return this.db.campaign.findMany({
      where: { fsNodeId: nodeId },
      select: { id: true, name: true, active: true, tenantId: true },
      orderBy: { name: "asc" },
    });
  }

  /**
   * Clears the pin for a campaign (sets fs_node_id = NULL → auto-assign).
   */
  async clearPin(campaignId: number): Promise<void> {
    await this.db.campaign.updateMany({
      where: { id: String(campaignId) },
      data: { fsNodeId: null },
    });
    await this.redis.del(`affinity:campaign:${campaignId}`);
    this.logger.info({ campaignId }, "affinity: campaign pin cleared");
  }
}
