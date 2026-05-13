// M08 — Golden FCC report integration test.
//
// Verifies the canonical denominator parity against D04 PLAN §8.2:
//   - human_answered rows returned by mock → drop_rate computed from SUM(human_answered)
//   - row count integrity (all rows counted; drop_rate denominator is human_answered, not total)
//
// This test is the "canonical denominator parity test" referenced in the task.

import { describe, it, expect, vi } from "vitest";
import { ReportingService } from "../../src/reporting/service.js";
import type { PrismaClient } from "@prisma/client";

describe("Golden FCC report — canonical denominator parity (D04 PLAN §8.2)", () => {
  it("5 human-answered calls, 1 drop → drop_rate = 20%, not 1/totalCalls", async () => {
    // Simulate a campaign with 8 total calls but only 5 human-answered
    // (3 AMD/carrier-fail calls that are NOT human-answered)
    const mockRow = {
      campaign_id: "GOLDEN-CAMP",
      total_calls: 8,
      // FCC denominator: SUM(s.human_answered) = 5
      human_answered: 5,
      drops: 1,
      sales: 2,
    };

    const prisma = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([mockRow]),
    } as unknown as PrismaClient;

    const svc = new ReportingService(prisma);
    const result = await svc.getFccDropRate(
      BigInt(1),
      "GOLDEN-CAMP",
      new Date("2026-04-13"),
      new Date("2026-05-13"),
    );

    // Golden assertion 1: row count
    expect(result.totalCalls).toBe(8);

    // Golden assertion 2: denominator is human_answered, not total_calls
    expect(result.humanAnswered).toBe(5); // SUM(s.human_answered)

    // Golden assertion 3: drop rate uses SUM(human_answered) as denominator
    // 1 drop / 5 human_answered = 20%  (NOT 1/8 = 12.5%)
    expect(result.dropRatePct).toBe(20);

    // Golden assertion 4: above FCC 3% threshold
    expect(result.dropRatePct).toBeGreaterThan(3);

    // Golden assertion 5: sales count correct
    expect(result.drops).toBe(1);
    expect(result.sales).toBe(2);
  });

  it("3% boundary: 3 drops / 100 human_answered = exactly 3.0% (not above threshold)", async () => {
    const mockRow = {
      campaign_id: "BOUNDARY-CAMP",
      total_calls: 150,
      human_answered: 100,
      drops: 3,
      sales: 10,
    };

    const prisma = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([mockRow]),
    } as unknown as PrismaClient;

    const svc = new ReportingService(prisma);
    const result = await svc.getFccDropRate(
      BigInt(1),
      "BOUNDARY-CAMP",
      new Date("2026-04-13"),
      new Date("2026-05-13"),
    );

    expect(result.dropRatePct).toBe(3); // exactly 3%
    // FCC safe harbor is >3%, so exactly 3% is still safe
    expect(result.dropRatePct).not.toBeGreaterThan(3);
  });

  it("zero human-answered → null drop rate (no division by zero)", async () => {
    const mockRow = {
      campaign_id: "AMD-ONLY-CAMP",
      total_calls: 50,
      human_answered: 0,
      drops: 0,
      sales: 0,
    };

    const prisma = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([mockRow]),
    } as unknown as PrismaClient;

    const svc = new ReportingService(prisma);
    const result = await svc.getFccDropRate(
      BigInt(1),
      "AMD-ONLY-CAMP",
      new Date("2026-04-13"),
      new Date("2026-05-13"),
    );

    // NULLIF(human_answered, 0) → NULL → drop_rate = null
    expect(result.dropRatePct).toBeNull();
    expect(result.totalCalls).toBe(50);
  });

  it("SQL issued to Prisma contains the canonical SUM(s.human_answered) expression", async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    const svc = new ReportingService(prisma);
    await svc.getFccDropRate(
      BigInt(1),
      "CHECK-SQL-CAMP",
      new Date("2026-04-13"),
      new Date("2026-05-13"),
    );

    const [sql] = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as [string];

    // Canonical denominator assertion — mirrors check-drop-rate-denominator.sh
    expect(sql).toMatch(/SUM\s*\(\s*s\.human_answered\s*\)/i);

    // Must join statuses table and resolve against __SYS__
    expect(sql).toMatch(/'__SYS__'/);

    // Must join on status column for flag resolution
    expect(sql).toMatch(/s\.status\s*=\s*cl\.status/i);
  });
});
