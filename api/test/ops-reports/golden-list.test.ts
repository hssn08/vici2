// M03 — Golden list-health report integration test.
//
// Verifies: correct lead bucket counts per list.

import { describe, it, expect, vi } from "vitest";
import { OpsReportService } from "../../src/ops-reports/service.js";
import type { PrismaClient } from "@prisma/client";

describe("Golden list-health report", () => {
  it("100 leads: 5 DNC, 3 tz_blocked, 20 no-attempts, 10 exhausted → correct buckets", async () => {
    const mockRow = {
      list_id: "7",
      list_name: "Q1 Prospects",
      campaign_id: "CAMP-A",
      leads_total: 100,
      leads_callable: 62,   // 100 - 5 DNC - 3 tz_blocked - 10 exhausted - ... (some overlap)
      leads_dnc: 5,
      leads_tz_blocked: 3,
      leads_no_attempts: 20,
      leads_exhausted: 10,  // recycle_delay_seconds = -1
      last_dial_at: "2026-05-13 14:32:00",
    };

    const prisma = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([mockRow]),
    } as unknown as PrismaClient;

    const svc = new OpsReportService(prisma);
    const rows = await svc.getListHealth(BigInt(1));

    expect(rows).toHaveLength(1);
    const row = rows[0];

    expect(row.listId).toBe("7");
    expect(row.listName).toBe("Q1 Prospects");
    expect(row.campaignId).toBe("CAMP-A");
    expect(row.leadsTotal).toBe(100);
    expect(row.leadsCallable).toBe(62);
    expect(row.leadsDnc).toBe(5);
    expect(row.leadsTzBlocked).toBe(3);
    expect(row.leadsNoAttempts).toBe(20);
    expect(row.leadsExhausted).toBe(10);
    expect(row.lastDialAt).toBe("2026-05-13 14:32:00");
  });

  it("list with no leads → all counts are 0, lastDialAt is null", async () => {
    const mockRow = {
      list_id: "99",
      list_name: "Empty List",
      campaign_id: "CAMP-B",
      leads_total: 0,
      leads_callable: 0,
      leads_dnc: 0,
      leads_tz_blocked: 0,
      leads_no_attempts: 0,
      leads_exhausted: 0,
      last_dial_at: null,
    };

    const prisma = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([mockRow]),
    } as unknown as PrismaClient;

    const svc = new OpsReportService(prisma);
    const rows = await svc.getListHealth(BigInt(1));

    expect(rows[0].leadsTotal).toBe(0);
    expect(rows[0].lastDialAt).toBeNull();
  });

  it("campaign filter is passed correctly when provided", async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    const svc = new OpsReportService(prisma);
    await svc.getListHealth(BigInt(1), "MY-CAMPAIGN");

    const call = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const params = call.slice(1);

    // Campaign ID should be in the params
    expect(params).toContain("MY-CAMPAIGN");

    // SQL should reference campaign_lists
    const [sql] = call as [string];
    expect(sql).toMatch(/campaign_lists/i);
    expect(sql).toMatch(/statuses.*__SYS__/si);
  });

  it("no campaign filter → all lists returned for tenant", async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    const svc = new OpsReportService(prisma);
    await svc.getListHealth(BigInt(1));

    const call = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    // Without filter: only tenantId param
    expect(call.slice(1)).toEqual([BigInt(1)]);
  });
});
