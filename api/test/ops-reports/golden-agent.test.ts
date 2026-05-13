// M03 — Golden agent-productivity report integration test.
//
// Verifies: sales_per_hour = sales / (time_talking_sec / 3600).

import { describe, it, expect, vi } from "vitest";
import { OpsReportService } from "../../src/ops-reports/service.js";
import type { PrismaClient } from "@prisma/client";

describe("Golden agent-productivity report", () => {
  it("3 calls, 1 sale, 7200s talking → sales_per_hour = 0.5", async () => {
    const mockRow = {
      user_id: "42",
      username: "jsmith",
      report_date: "2026-05-13",
      calls_handled: 3,
      time_ready_sec: 3600,
      time_paused_sec: 900,
      time_talking_sec: 7200,   // 2 hours
      time_acw_sec: 600,
      sales: 1,                 // 1 sale in 2 hours → 0.5 sales/hr
    };

    const prisma = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([mockRow]),
    } as unknown as PrismaClient;

    const svc = new OpsReportService(prisma);
    const rows = await svc.getAgentProductivity(
      BigInt(1),
      new Date("2026-05-13"),
      new Date("2026-05-13"),
    );

    expect(rows).toHaveLength(1);
    const row = rows[0];

    expect(row.userId).toBe("42");
    expect(row.username).toBe("jsmith");
    expect(row.callsHandled).toBe(3);
    expect(row.timeReadySec).toBe(3600);
    expect(row.timePausedSec).toBe(900);
    expect(row.timeTalkingSec).toBe(7200);
    expect(row.timeAcwSec).toBe(600);
    expect(row.sales).toBe(1);
    // 1 sale / (7200 / 3600) hours = 0.5 sales/hour
    expect(row.salesPerHour).toBe(0.5);
  });

  it("zero talking time → salesPerHour is null (no division by zero)", async () => {
    const mockRow = {
      user_id: "99",
      username: "idle_agent",
      report_date: "2026-05-13",
      calls_handled: 0,
      time_ready_sec: 3600,
      time_paused_sec: 0,
      time_talking_sec: 0,
      time_acw_sec: 0,
      sales: 0,
    };

    const prisma = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([mockRow]),
    } as unknown as PrismaClient;

    const svc = new OpsReportService(prisma);
    const rows = await svc.getAgentProductivity(
      BigInt(1),
      new Date("2026-05-13"),
      new Date("2026-05-13"),
    );

    expect(rows[0].salesPerHour).toBeNull();
  });

  it("agent filter is passed to SQL as parameter", async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    const svc = new OpsReportService(prisma);
    await svc.getAgentProductivity(
      BigInt(1),
      new Date("2026-05-01"),
      new Date("2026-05-13"),
      "42",
    );

    const call = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const params = call.slice(1);

    // user_id "42" should appear in params
    expect(params).toContain("42");

    // SQL should join users table
    const [sql] = call as [string];
    expect(sql).toMatch(/JOIN\s+users/i);
  });
});
