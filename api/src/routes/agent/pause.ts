// A09 — Agent pause-codes + state transition routes.
//
// Route map:
//   GET  /api/agent/pause-codes  pause-code:read  → PauseCodesConfig
//   POST /api/agent/state        (own agent only)  → AgentStateResponse

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type App = any;

import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../../lib/prisma.js';
import type { AuthContext } from '../../auth/middleware.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

type AuthReq = FastifyRequest & { auth?: AuthContext };

interface PauseCodeOption {
  code: string;
  name: string;
  billable: boolean;
}

interface PauseCodesResponse {
  pauseCodesRequired: 'OFF' | 'OPTIONAL' | 'FORCE';
  codes: PauseCodeOption[];
}

interface AgentStateResponse {
  status: 'ready' | 'paused' | 'logged-out';
  pauseCode: string | null;
  pausedSince: number | null;
}

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const SetAgentStateSchema = z.object({
  status: z.enum(['ready', 'paused', 'logged-out']),
  pauseCode: z.string().max(16).nullable().optional(),
  pauseReason: z.string().max(255).nullable().optional(),
});

// ---------------------------------------------------------------------------
// GET /api/agent/pause-codes
// ---------------------------------------------------------------------------

async function handleGetPauseCodes(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = (req as AuthReq).auth!;
  const prisma = getPrisma();

  // Determine current campaignId from agent store (stored in Valkey by A03).
  // For now, we read from the agent state embedded in the JWT claims if present,
  // or fall back to null (no campaign). The Valkey lookup is best-effort;
  // if the key is absent we fall back to tenant-global codes + OPTIONAL mode.
  const currentCampaignId: string | null = null; // populated by A03 Valkey reads in future

  let pauseCodesRequired: 'OFF' | 'OPTIONAL' | 'FORCE' = 'OPTIONAL';

  // If the agent is in a campaign, fetch that campaign's pauseCodesRequired.
  if (currentCampaignId) {
    const campaign = await prisma.campaign.findFirst({
      where: { tenantId: BigInt(auth.tenantId), id: currentCampaignId },
      select: { pauseCodesRequired: true },
    });
    if (campaign) {
      pauseCodesRequired = campaign.pauseCodesRequired as 'OFF' | 'OPTIONAL' | 'FORCE';
    }
  }

  // Fetch codes: campaign-specific first, then tenant-global (NULL campaign_id).
  const rawCodes = await prisma.pauseCode.findMany({
    where: {
      tenantId: BigInt(auth.tenantId),
      OR: [
        { campaignId: currentCampaignId },
        { campaignId: null },
      ],
    },
    orderBy: [
      // Campaign-specific codes listed before global codes.
      // Prisma doesn't support ORDER BY ISNULL natively; sort client-side.
      { code: 'asc' },
    ],
    select: { code: true, name: true, billable: true, campaignId: true },
  });

  // Sort: campaign-specific codes first, then global.
  const sorted = [...rawCodes].sort((a, b) => {
    const aIsGlobal = a.campaignId === null ? 1 : 0;
    const bIsGlobal = b.campaignId === null ? 1 : 0;
    return aIsGlobal - bIsGlobal;
  });

  // Deduplicate by code (campaign-specific wins over global of same code).
  const seen = new Set<string>();
  const codes: PauseCodeOption[] = [];
  for (const c of sorted) {
    if (!seen.has(c.code)) {
      seen.add(c.code);
      codes.push({ code: c.code, name: c.name, billable: c.billable });
    }
  }

  const response: PauseCodesResponse = { pauseCodesRequired, codes };
  return reply.send(response);
}

// ---------------------------------------------------------------------------
// POST /api/agent/state
// ---------------------------------------------------------------------------

async function handleSetAgentState(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = (req as AuthReq).auth!;
  const prisma = getPrisma();

  // Validate body
  const parseResult = SetAgentStateSchema.safeParse(req.body);
  if (!parseResult.success) {
    return reply.code(400).send({
      error: 'INVALID_BODY',
      details: parseResult.error.flatten(),
    });
  }

  const { status, pauseCode = null, pauseReason = null } = parseResult.data;

  // For FORCE-mode validation: determine the campaign's pauseCodesRequired.
  // currentCampaignId comes from agent state (Valkey, not yet wired); stub null.
  const currentCampaignId: string | null = null;

  if (status === 'paused') {
    let pauseCodesRequired: 'OFF' | 'OPTIONAL' | 'FORCE' = 'OPTIONAL';

    if (currentCampaignId) {
      const campaign = await prisma.campaign.findFirst({
        where: { tenantId: BigInt(auth.tenantId), id: currentCampaignId },
        select: { pauseCodesRequired: true },
      });
      if (campaign) {
        pauseCodesRequired = campaign.pauseCodesRequired as 'OFF' | 'OPTIONAL' | 'FORCE';
      }
    }

    if (pauseCodesRequired === 'FORCE') {
      if (!pauseCode) {
        return reply.code(400).send({ error: 'PAUSE_CODE_REQUIRED' });
      }
      // Validate the code exists for this tenant/campaign.
      const valid = await prisma.pauseCode.findFirst({
        where: {
          tenantId: BigInt(auth.tenantId),
          code: pauseCode,
          OR: [
            { campaignId: currentCampaignId },
            { campaignId: null },
          ],
        },
      });
      if (!valid) {
        return reply.code(400).send({ error: 'INVALID_PAUSE_CODE' });
      }
    }

    // Write agent_log row for pause event.
    const now = new Date();
    await prisma.agentLog.create({
      data: {
        tenantId: BigInt(auth.tenantId),
        userId: BigInt(auth.uid),
        campaignId: currentCampaignId,
        eventAt: now,
        event: 'pause',
        pauseCode: pauseCode ?? null,
        metadata: pauseReason ? { reason: pauseReason } : null,
      },
    });

    const pausedSince = Date.now();
    const response: AgentStateResponse = { status: 'paused', pauseCode: pauseCode ?? null, pausedSince };
    return reply.send(response);
  }

  if (status === 'ready') {
    // Write agent_log row for unpause event.
    const now = new Date();
    await prisma.agentLog.create({
      data: {
        tenantId: BigInt(auth.tenantId),
        userId: BigInt(auth.uid),
        campaignId: currentCampaignId,
        eventAt: now,
        event: 'unpause',
        // durationSec: calculated from pausedSince — requires Valkey state, stubbed.
      },
    });

    const response: AgentStateResponse = { status: 'ready', pauseCode: null, pausedSince: null };
    return reply.send(response);
  }

  // logged-out or other status
  const response: AgentStateResponse = { status: status as 'ready' | 'paused' | 'logged-out', pauseCode: null, pausedSince: null };
  return reply.send(response);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerAgentPauseRoutes(app: App): Promise<void> {
  app.get('/api/agent/pause-codes', {
    preHandler: [app.requireAuth, app.requirePermission('pause-code:read')],
  }, handleGetPauseCodes);

  app.post('/api/agent/state', {
    preHandler: [app.requireAuth],
  }, handleSetAgentState);
}
