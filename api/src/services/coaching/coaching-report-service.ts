// S05 — CoachingReportService
// agent-trend, team-summary, M03 coaching_stats sub-object
// S05 PLAN §8

import type { PrismaClient } from '@prisma/client';
import { startOfDay, startOfWeek, startOfMonth, addDays, addWeeks, addMonths } from 'date-fns';

export type TrendInterval = 'day' | 'week' | 'month';

export interface CoachingStats {
  evaluations_received: number;
  avg_scorecard_score: number | null;
  feedback_items: number;
  unacknowledged_feedback: number;
  trend_7d_delta: number | null;
}

export class CoachingReportService {
  constructor(private readonly db: PrismaClient) {}

  // ── M03 coaching_stats sub-object ─────────────────────────────────────────

  async getCoachingStats(params: {
    tenantId: number;
    agentId: number;
    from: Date;
    to: Date;
  }): Promise<CoachingStats> {
    const tenantId = BigInt(params.tenantId);
    const agentId = BigInt(params.agentId);

    const [scorecards, allFeedback, unackFeedback] = await Promise.all([
      this.db.callScorecard.findMany({
        where: {
          tenantId,
          agentId,
          status: 'finalized',
          isCalibration: false,
          createdAt: { gte: params.from, lte: params.to },
        },
        select: { totalScore: true, createdAt: true },
      }),
      this.db.agentFeedback.count({
        where: {
          tenantId,
          agentId,
          createdAt: { gte: params.from, lte: params.to },
        },
      }),
      this.db.agentFeedback.count({
        where: {
          tenantId,
          agentId,
          acknowledgedAt: null,
          createdAt: { gte: params.from, lte: params.to },
        },
      }),
    ]);

    type ScorecardRow = { totalScore: unknown; createdAt: Date };
    const avgScore =
      scorecards.length > 0
        ? scorecards.reduce((acc: number, s: ScorecardRow) => acc + Number(s.totalScore), 0) / scorecards.length
        : null;

    // 7d trend delta
    const sevenDaysAgo = new Date(params.to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(params.to.getTime() - 14 * 24 * 60 * 60 * 1000);
    const recent7 = scorecards.filter((s: ScorecardRow) => s.createdAt >= sevenDaysAgo);
    const prior7 = scorecards.filter((s: ScorecardRow) => s.createdAt >= fourteenDaysAgo && s.createdAt < sevenDaysAgo);

    let trend7dDelta: number | null = null;
    if (recent7.length >= 2 && prior7.length >= 2) {
      const recentAvg = recent7.reduce((a: number, s: ScorecardRow) => a + Number(s.totalScore), 0) / recent7.length;
      const priorAvg = prior7.reduce((a: number, s: ScorecardRow) => a + Number(s.totalScore), 0) / prior7.length;
      trend7dDelta = Math.round((recentAvg - priorAvg) * 100) / 100;
    }

    return {
      evaluations_received: scorecards.length,
      avg_scorecard_score: avgScore !== null ? Math.round(avgScore * 100) / 100 : null,
      feedback_items: allFeedback,
      unacknowledged_feedback: unackFeedback,
      trend_7d_delta: trend7dDelta,
    };
  }

  // ── Agent trend endpoint ───────────────────────────────────────────────────

  async getAgentTrend(params: {
    tenantId: number;
    agentId: number;
    templateId?: number;
    from: Date;
    to: Date;
    interval: TrendInterval;
  }) {
    const tenantId = BigInt(params.tenantId);
    const agentId = BigInt(params.agentId);

    const agent = await this.db.user.findFirst({
      where: { id: agentId, tenantId },
      select: { id: true, fullName: true, username: true },
    });
    if (!agent) return null;

    let template: { id: bigint; name: string; version: number } | null = null;
    if (params.templateId) {
      template = await this.db.scorecardTemplate.findFirst({
        where: { id: BigInt(params.templateId), tenantId },
        select: { id: true, name: true, version: true },
      });
    }

    const scorecards = await this.db.callScorecard.findMany({
      where: {
        tenantId,
        agentId,
        status: 'finalized',
        isCalibration: false,
        createdAt: { gte: params.from, lte: params.to },
        ...(params.templateId ? { templateId: BigInt(params.templateId) } : {}),
      },
      select: { totalScore: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    // Group by interval
    const dataPoints = this.groupByInterval(scorecards, params.from, params.to, params.interval);

    const allScores = scorecards.map((s: { totalScore: unknown; createdAt: Date }) => Number(s.totalScore));
    const avgScore = allScores.length > 0
      ? Math.round((allScores.reduce((a: number, b: number) => a + b, 0) / allScores.length) * 100) / 100
      : null;

    // Tag distribution from annotations
    const annotationStats = await this.db.callAnnotation.groupBy({
      by: ['tag'],
      where: {
        tenantId,
        scorecard: { agentId, status: 'finalized', isCalibration: false },
        createdAt: { gte: params.from, lte: params.to },
      },
      _count: { id: true },
    });
    const evalsByTag = Object.fromEntries(
      annotationStats.map((a: { tag: string; _count: { id: number } }) => [a.tag, a._count.id]),
    );

    // trend delta: last data point vs second-to-last
    let trendDelta: number | null = null;
    if (dataPoints.length >= 2) {
      const last = dataPoints[dataPoints.length - 1]!;
      const prev = dataPoints[dataPoints.length - 2]!;
      if (last.avg_score !== null && prev.avg_score !== null) {
        trendDelta = Math.round((last.avg_score - prev.avg_score) * 100) / 100;
      }
    }

    return {
      agent_id: Number(agentId),
      agent_name: agent.fullName ?? agent.username,
      template_id: template ? Number(template.id) : null,
      template_name: template?.name ?? null,
      period: {
        from: params.from.toISOString().slice(0, 10),
        to: params.to.toISOString().slice(0, 10),
      },
      data_points: dataPoints,
      summary: {
        avg_score: avgScore,
        total_evaluations: scorecards.length,
        trend_delta: trendDelta,
        evaluations_by_tag: evalsByTag,
      },
    };
  }

  // ── Team summary endpoint ──────────────────────────────────────────────────

  async getTeamSummary(params: {
    tenantId: number;
    supervisorId: number;
    campaignId?: string;
    templateId?: number;
    from: Date;
    to: Date;
  }) {
    const tenantId = BigInt(params.tenantId);

    // Get agents in supervisor's group
    const supervisor = await this.db.user.findFirst({
      where: { id: BigInt(params.supervisorId), tenantId },
      select: { userGroupId: true },
    });

    const agentFilter = supervisor?.userGroupId
      ? { tenantId, userGroupId: supervisor.userGroupId, role: 'agent' as const }
      : { tenantId, role: 'agent' as const };

    const agents = await this.db.user.findMany({
      where: agentFilter,
      select: { id: true, fullName: true, username: true },
    });

    const agentIds = agents.map((a: { id: bigint }) => a.id);

    const scorecards = await this.db.callScorecard.findMany({
      where: {
        tenantId,
        agentId: { in: agentIds },
        status: 'finalized',
        isCalibration: false,
        createdAt: { gte: params.from, lte: params.to },
        ...(params.campaignId ? { campaignId: params.campaignId } : {}),
        ...(params.templateId ? { templateId: BigInt(params.templateId) } : {}),
      },
      select: { agentId: true, totalScore: true },
    });

    // Per-agent averages
    const byAgent = new Map<string, number[]>();
    for (const s of scorecards) {
      const key = String(s.agentId);
      if (!byAgent.has(key)) byAgent.set(key, []);
      byAgent.get(key)!.push(Number(s.totalScore));
    }

    const rows = agents.map((agent: { id: bigint; fullName: string | null; username: string }) => {
      const scores = byAgent.get(String(agent.id)) ?? [];
      const avg = scores.length > 0
        ? Math.round((scores.reduce((a: number, b: number) => a + b, 0) / scores.length) * 100) / 100
        : null;
      return {
        agent_id: Number(agent.id),
        agent_name: agent.fullName ?? agent.username,
        avg_score: avg,
        eval_count: scores.length,
      };
    });

    return {
      from: params.from.toISOString().slice(0, 10),
      to: params.to.toISOString().slice(0, 10),
      agents: rows.sort((a: { avg_score: number | null }, b: { avg_score: number | null }) => (b.avg_score ?? -1) - (a.avg_score ?? -1)),
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private groupByInterval(
    scorecards: Array<{ totalScore: unknown; createdAt: Date }>,
    from: Date,
    to: Date,
    interval: TrendInterval,
  ) {
    const buckets = new Map<string, number[]>();

    // Pre-create bucket keys
    let cursor = this.bucketStart(from, interval);
    while (cursor <= to) {
      buckets.set(cursor.toISOString().slice(0, 10), []);
      cursor = this.advance(cursor, interval);
    }

    for (const s of scorecards) {
      const key = this.bucketStart(s.createdAt, interval).toISOString().slice(0, 10);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(Number(s.totalScore));
    }

    return Array.from(buckets.entries()).map(([date, scores]) => ({
      date,
      avg_score: scores.length > 0
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100
        : null,
      eval_count: scores.length,
    }));
  }

  private bucketStart(d: Date, interval: TrendInterval): Date {
    switch (interval) {
      case 'day': return startOfDay(d);
      case 'week': return startOfWeek(d, { weekStartsOn: 1 });
      case 'month': return startOfMonth(d);
    }
  }

  private advance(d: Date, interval: TrendInterval): Date {
    switch (interval) {
      case 'day': return addDays(d, 1);
      case 'week': return addWeeks(d, 1);
      case 'month': return addMonths(d, 1);
    }
  }
}
