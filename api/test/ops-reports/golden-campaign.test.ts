// M03 — Golden campaign-daily report integration test.
//
// Verifies canonical denominator parity against D04 PLAN §8.2:
//   contacts = SUM(s.human_answered) — NOT COUNT(*).
//   drop_rate_pct = drops / NULLIF(contacts, 0) * 100.

import { describe, it, expect, vi } from "vitest";
import { OpsReportService } from "../../src/ops-reports/service.js";
import type { PrismaClient } from "@prisma/client";

describe("Golden campaign-daily report — canonical denominator parity (D04 PLAN §8.2)", () => {
  it("10 calls, 6 human-answered, 1 drop → drop_rate = 1/6 ≈ 16.67%, contacts = 6", async () => {
    const mockRow = {
      campaign_id: "GOLDEN-CAMP",
      report_date: "2026-05-13",
      calls_attempted: 10,
      calls_connected: 7,
      // FCC denominator: SUM(s.human_answered) = 6 (not 10)
      contacts: 6,
      sales: 2,
      drops: 1,
      avg_call_duration_sec: 42.5,
      abandon_rate_pct: 14.29,
    };

    const prisma = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([mockRow]),
    } as unknown as PrismaClient;

    const svc = new OpsReportService(prisma);
    const rows = await svc.getCampaignDaily(
      BigInt(1),
      new Date("2026-05-01"),
      new Date("2026-05-13"),
      "GOLDEN-CAMP",
    );

    expect(rows).toHaveLength(1);
    const row = rows[0];

    // Golden assertion 1: all basic counts
    expect(row.callsAttempted).toBe(10);
    expect(row.callsConnected).toBe(7);

    // Golden assertion 2: contacts = SUM(human_answered), not total calls
    expect(row.contacts).toBe(6); // SUM(s.human_answered)

    // Golden assertion 3: drop_rate denominator is contacts (human_answered), not total
    // 1 drop / 6 human_answered = 16.67%  (NOT 1/10 = 10%)
    expect(row.drops).toBe(1);
    expect(row.dropRatePct).toBeCloseTo(16.67, 1);

    // Golden assertion 4: sales
    expect(row.sales).toBe(2);

    // Golden assertion 5: avg duration
    expect(row.avgCallDurationSec).toBe(42.5);
  });

  it("zero contacts → drop_rate is null (no division by zero)", async () => {
    const mockRow = {
      campaign_id: "AMD-CAMP",
      report_date: "2026-05-13",
      calls_attempted: 20,
      calls_connected: 0,
      contacts: 0,
      sales: 0,
      drops: 0,
      avg_call_duration_sec: null,
      abandon_rate_pct: null,
    };

    const prisma = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([mockRow]),
    } as unknown as PrismaClient;

    const svc = new OpsReportService(prisma);
    const rows = await svc.getCampaignDaily(
      BigInt(1),
      new Date("2026-05-01"),
      new Date("2026-05-13"),
    );

    expect(rows[0].dropRatePct).toBeNull();
    expect(rows[0].avgCallDurationSec).toBeNull();
  });

  it("SQL query contains SUM(s.human_answered) as contacts denominator and joins __SYS__", async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    const svc = new OpsReportService(prisma);
    await svc.getCampaignDaily(
      BigInt(1),
      new Date("2026-05-01"),
      new Date("2026-05-13"),
    );

    const [sql] = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as [string];

    // Canonical denominator assertion — mirrors check-drop-rate-denominator.sh
    expect(sql).toMatch(/SUM\s*\(\s*s\.human_answered\s*\)/i);

    // Must join statuses with __SYS__ sentinel
    expect(sql).toMatch(/'__SYS__'/);

    // Must use call_log as the base table
    expect(sql).toMatch(/call_log/i);
  });

  it("empty result set → returns empty array", async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    const svc = new OpsReportService(prisma);
    const rows = await svc.getCampaignDaily(
      BigInt(1),
      new Date("2026-05-01"),
      new Date("2026-05-13"),
    );

    expect(rows).toHaveLength(0);
  });
});
