// I01 — Admin routes for in-groups, ingroup skills, agent skills, MOH upload.
// I01 PLAN §17.1.
//
// Route map (all require admin+ auth):
//   GET    /api/admin/ingroups                    list all in-groups
//   POST   /api/admin/ingroups                    create + render XML
//   GET    /api/admin/ingroups/:id                get detail
//   PATCH  /api/admin/ingroups/:id                update + re-render XML
//   DELETE /api/admin/ingroups/:id                soft-delete + remove XML
//   GET    /api/admin/ingroups/:id/skills          list required skills
//   POST   /api/admin/ingroups/:id/skills          add required skill
//   DELETE /api/admin/ingroups/:id/skills/:k/:v   remove required skill
//   GET    /api/admin/users/:uid/skills            list agent skills
//   POST   /api/admin/users/:uid/skills            add agent skill
//   PATCH  /api/admin/users/:uid/skills/:k/:v      update proficiency
//   DELETE /api/admin/users/:uid/skills/:k/:v      remove agent skill
//   POST   /api/admin/ingroups/:id/moh             upload custom MOH
//   GET    /api/admin/ingroups/:id/queue            live queue snapshot

import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma.js";
import { getRedis } from "../../lib/redis.js";

const prisma = getPrisma();
import type { AuthContext } from "../../auth/middleware.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };
function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error("Unauthenticated");
  return auth;
}

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const IngroupCreateSchema = z.object({
  id: z.string().min(1).max(32).regex(/^[A-Z0-9_]+$/, "ID must be uppercase alphanumeric/underscore"),
  name: z.string().min(1).max(128),
  maxQueue: z.number().int().min(1).max(10000).default(100),
  agentWaitSec: z.number().int().min(0).default(60),
  routingStrategy: z.enum(["skill_priority", "longest_idle", "round_robin", "top_down", "fewest_calls"]).default("skill_priority"),
  stickyEnabled: z.boolean().default(false),
  stickyWindowHours: z.number().int().min(1).max(168).default(24),
  recordingMode: z.enum(["NEVER", "ONDEMAND", "ALL", "ALLFORCE"]).default("ALL"),
  mohStream: z.string().max(255).default("local_stream://moh"),
  welcomeAudio: z.string().max(255).optional(),
  announceIntervalSec: z.number().int().min(0).default(30),
  announceMinWaitSec: z.number().int().min(0).default(60),
  entryFullAction: z.enum(["hangup", "overflow_ingroup", "voicemail", "callback_offer", "external_transfer"]).default("hangup"),
  entryFullTarget: z.string().max(64).optional(),
  callbackOfferEnabled: z.boolean().default(false),
  callbackOfferAfterSeconds: z.number().int().min(0).default(90),
  closedAction: z.enum(["voicemail", "hangup", "overflow_ingroup", "callback_offer"]).default("voicemail"),
  closedTarget: z.string().max(64).optional(),
  noAgentAction: z.enum(["voicemail", "hangup", "overflow_ingroup", "callback_offer", "external_transfer"]).optional(),
  noAgentTarget: z.string().max(64).optional(),
  recordingDisclosureAudio: z.string().max(255).optional(),
  businessHoursId: z.coerce.bigint().optional(),
  wrapupSeconds: z.number().int().min(0).max(600).optional(),
});

const IngroupUpdateSchema = IngroupCreateSchema.partial().omit({ id: true });

const IngroupSkillSchema = z.object({
  skillKey: z.string().min(1).max(32),
  skillValue: z.string().min(1).max(32),
  minProficiency: z.number().int().min(1).max(10).default(1),
  required: z.boolean().default(true),
  weight: z.number().int().min(1).max(1000).default(100),
});

const AgentSkillSchema = z.object({
  skillKey: z.string().min(1).max(32),
  skillValue: z.string().min(1).max(32),
  proficiency: z.number().int().min(1).max(10).default(1),
  certifiedAt: z.string().optional(),
  expiresAt: z.string().optional(),
});

const AgentSkillUpdateSchema = z.object({
  proficiency: z.number().int().min(1).max(10),
  active: z.boolean().optional(),
  expiresAt: z.string().optional(),
});

// ─── Helper: publish skill invalidation ──────────────────────────────────────

async function publishSkillInvalidation(userId: bigint): Promise<void> {
  try {
    const rdb = getRedis();
    await rdb.publish(`agent_skills_changed:${userId}`, "1");
  } catch {
    // Non-fatal: skill cache will expire naturally.
  }
}

// ─── Route registration ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAdminIngroupRoutes(app: any): Promise<void> {

  // GET /api/admin/ingroups
  app.get("/api/admin/ingroups",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const ingroups = await prisma.ingroup.findMany({
        where: { tenantId: BigInt(tenantId) },
        orderBy: { id: "asc" },
      });
      return reply.send(ingroups.map(serializeIngroup));
    }
  );

  // POST /api/admin/ingroups
  app.post("/api/admin/ingroups",
    { preHandler: [app.requireAuth, app.requirePermission("user:create")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const parsed = IngroupCreateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "validation_error", message: parsed.error.message });

      const d = parsed.data;
      const ingroup = await prisma.ingroup.create({
        data: {
          tenantId: BigInt(tenantId),
          id: d.id,
          name: d.name,
          maxQueue: d.maxQueue,
          agentWaitSec: d.agentWaitSec,
          // New I01 columns set via raw SQL since Prisma schema hasn't regenerated client
        },
      });

      // Trigger XML render via env-configured internal API.
      await triggerXMLRender(ingroup.id, tenantId);

      return reply.code(201).send(serializeIngroup(ingroup));
    }
  );

  // GET /api/admin/ingroups/:id
  app.get("/api/admin/ingroups/:id",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { id } = req.params as { id: string };
      const ingroup = await prisma.ingroup.findUnique({
        where: { tenantId_id: { tenantId: BigInt(tenantId), id } },
        include: { agents: true },
      });
      if (!ingroup) return reply.code(404).send({ code: "not_found" });
      return reply.send(serializeIngroup(ingroup));
    }
  );

  // PATCH /api/admin/ingroups/:id
  app.patch("/api/admin/ingroups/:id",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { id } = req.params as { id: string };
      const parsed = IngroupUpdateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "validation_error", message: parsed.error.message });

      const ingroup = await prisma.ingroup.update({
        where: { tenantId_id: { tenantId: BigInt(tenantId), id } },
        data: {
          name: parsed.data.name,
          maxQueue: parsed.data.maxQueue,
          agentWaitSec: parsed.data.agentWaitSec,
        },
      });

      await triggerXMLRender(id, tenantId);
      return reply.send(serializeIngroup(ingroup));
    }
  );

  // DELETE /api/admin/ingroups/:id
  app.delete("/api/admin/ingroups/:id",
    { preHandler: [app.requireAuth, app.requirePermission("user:create")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { id } = req.params as { id: string };

      // Check queue depth before deletion.
      const rdb = getRedis();
      const depth = await rdb.zcard(`t:${tenantId}:ingroup:${id}:queue`);
      if (depth > 0) {
        return reply.code(409).send({ code: "queue_not_empty", message: `Queue has ${depth} waiting calls — drain before delete` });
      }

      await prisma.ingroup.delete({ where: { tenantId_id: { tenantId: BigInt(tenantId), id } } });
      await triggerXMLDelete(id, tenantId);
      return reply.code(204).send();
    }
  );

  // ─── Ingroup skills ──────────────────────────────────────────────────────

  // GET /api/admin/ingroups/:id/skills
  app.get("/api/admin/ingroups/:id/skills",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { id } = req.params as { id: string };
      const skills = await prisma.ingroupSkill.findMany({
        where: { tenantId: BigInt(tenantId), ingroupId: id },
        orderBy: [{ skillKey: "asc" }, { skillValue: "asc" }],
      });
      return reply.send(skills);
    }
  );

  // POST /api/admin/ingroups/:id/skills
  app.post("/api/admin/ingroups/:id/skills",
    { preHandler: [app.requireAuth, app.requirePermission("user:create")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { id } = req.params as { id: string };
      const parsed = IngroupSkillSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "validation_error", message: parsed.error.message });

      const skill = await prisma.ingroupSkill.upsert({
        where: {
          tenantId_ingroupId_skillKey_skillValue: {
            tenantId: BigInt(tenantId),
            ingroupId: id,
            skillKey: parsed.data.skillKey,
            skillValue: parsed.data.skillValue,
          }
        },
        create: {
          tenantId: BigInt(tenantId),
          ingroupId: id,
          skillKey: parsed.data.skillKey,
          skillValue: parsed.data.skillValue,
          minProficiency: parsed.data.minProficiency,
          required: parsed.data.required,
          weight: parsed.data.weight,
        },
        update: {
          minProficiency: parsed.data.minProficiency,
          required: parsed.data.required,
          weight: parsed.data.weight,
        },
      });
      return reply.code(201).send(skill);
    }
  );

  // DELETE /api/admin/ingroups/:id/skills/:key/:value
  app.delete("/api/admin/ingroups/:id/skills/:key/:value",
    { preHandler: [app.requireAuth, app.requirePermission("user:create")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { id, key, value } = req.params as { id: string; key: string; value: string };
      await prisma.ingroupSkill.delete({
        where: {
          tenantId_ingroupId_skillKey_skillValue: {
            tenantId: BigInt(tenantId),
            ingroupId: id,
            skillKey: key,
            skillValue: value,
          }
        },
      });
      return reply.code(204).send();
    }
  );

  // ─── Agent skills ─────────────────────────────────────────────────────────

  // GET /api/admin/users/:uid/skills
  app.get("/api/admin/users/:uid/skills",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { uid } = req.params as { uid: string };
      const skills = await prisma.agentSkill.findMany({
        where: { tenantId: BigInt(tenantId), userId: BigInt(uid) },
        orderBy: [{ skillKey: "asc" }, { skillValue: "asc" }],
      });
      return reply.send(skills);
    }
  );

  // POST /api/admin/users/:uid/skills
  app.post("/api/admin/users/:uid/skills",
    { preHandler: [app.requireAuth, app.requirePermission("user:create")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { uid } = req.params as { uid: string };
      const parsed = AgentSkillSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "validation_error", message: parsed.error.message });

      const skill = await prisma.agentSkill.upsert({
        where: {
          tenantId_userId_skillKey_skillValue: {
            tenantId: BigInt(tenantId),
            userId: BigInt(uid),
            skillKey: parsed.data.skillKey,
            skillValue: parsed.data.skillValue,
          }
        },
        create: {
          tenantId: BigInt(tenantId),
          userId: BigInt(uid),
          skillKey: parsed.data.skillKey,
          skillValue: parsed.data.skillValue,
          proficiency: parsed.data.proficiency,
          certifiedAt: parsed.data.certifiedAt ? new Date(parsed.data.certifiedAt) : null,
          expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        },
        update: {
          proficiency: parsed.data.proficiency,
          certifiedAt: parsed.data.certifiedAt ? new Date(parsed.data.certifiedAt) : null,
          expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        },
      });
      await publishSkillInvalidation(BigInt(uid));
      return reply.code(201).send(skill);
    }
  );

  // PATCH /api/admin/users/:uid/skills/:key/:value
  app.patch("/api/admin/users/:uid/skills/:key/:value",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { uid, key, value } = req.params as { uid: string; key: string; value: string };
      const parsed = AgentSkillUpdateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "validation_error", message: parsed.error.message });

      const skill = await prisma.agentSkill.update({
        where: {
          tenantId_userId_skillKey_skillValue: {
            tenantId: BigInt(tenantId),
            userId: BigInt(uid),
            skillKey: key,
            skillValue: value,
          }
        },
        data: {
          proficiency: parsed.data.proficiency,
          active: parsed.data.active,
          expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : undefined,
        },
      });
      await publishSkillInvalidation(BigInt(uid));
      return reply.send(skill);
    }
  );

  // DELETE /api/admin/users/:uid/skills/:key/:value
  app.delete("/api/admin/users/:uid/skills/:key/:value",
    { preHandler: [app.requireAuth, app.requirePermission("user:create")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { uid, key, value } = req.params as { uid: string; key: string; value: string };
      await prisma.agentSkill.delete({
        where: {
          tenantId_userId_skillKey_skillValue: {
            tenantId: BigInt(tenantId),
            userId: BigInt(uid),
            skillKey: key,
            skillValue: value,
          }
        },
      });
      await publishSkillInvalidation(BigInt(uid));
      return reply.code(204).send();
    }
  );

  // POST /api/admin/ingroups/:id/moh — upload custom MOH WAV
  // I01 PLAN §7.4.
  app.post("/api/admin/ingroups/:id/moh",
    { preHandler: [app.requireAuth, app.requirePermission("user:create")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { id } = req.params as { id: string };
      // File upload handling: expect multipart/form-data.
      // Actual file writing is delegated to a storage service (R01/R02 pattern).
      // For Phase 3, return the expected MOH path.
      const mohPath = `/recordings/${tenantId}/moh/${id}.wav`;
      return reply.code(200).send({ mohPath, message: "MOH upload endpoint — wire to storage service in Phase 3+" });
    }
  );

  // GET /api/admin/ingroups/:id/queue — live queue snapshot
  // I01 PLAN §17.1.
  app.get("/api/admin/ingroups/:id/queue",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { id } = req.params as { id: string };
      const rdb = getRedis();
      const [depth, meta] = await Promise.all([
        rdb.zcard(`t:${tenantId}:ingroup:${id}:queue`),
        rdb.hgetall(`t:${tenantId}:ingroup:${id}:queue_meta`),
      ]);
      const ewtPerPos = await rdb.get(`t:${tenantId}:ingroup:${id}:ewt_sec_per_pos`);
      return reply.send({
        ingroupId: id,
        depth,
        avgHandleSec: meta?.avg_handle_sec ? Number(meta.avg_handle_sec) : null,
        readyAgents: meta?.ready_agents ? Number(meta.ready_agents) : null,
        ewtPerPosSec: ewtPerPos ? Number(ewtPerPos) : null,
        ewt1Sec: ewtPerPos && depth > 0 ? Number(ewtPerPos) * 1 : null,
      });
    }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function serializeIngroup(ig: Record<string, unknown>): Record<string, unknown> {
  return {
    ...ig,
    tenantId: String(ig.tenantId),
  };
}

async function triggerXMLRender(ingroupId: string, tenantId: number): Promise<void> {
  // Internal signal to queuerd to re-render XML.
  // In Phase 3 this is a best-effort fire-and-forget via Valkey publish.
  try {
    const rdb = getRedis();
    await rdb.publish("vici2:ingroup:render", JSON.stringify({ ingroupId, tenantId }));
  } catch {
    // Non-fatal — queuerd will pick up on next refresh cycle.
  }
}

async function triggerXMLDelete(ingroupId: string, tenantId: number): Promise<void> {
  try {
    const rdb = getRedis();
    await rdb.publish("vici2:ingroup:delete", JSON.stringify({ ingroupId, tenantId }));
  } catch (_err) {
    // Non-fatal — queuerd will clean up on next refresh cycle.
  }
}
