import { describe, expect, it } from "vitest";
import { normalizePhone, syncContacts } from "../../../src/integrations/hubspot/sync-contacts.js";
import { FakeHubspotClient } from "../../../src/integrations/hubspot/hubspot-client.js";

describe("normalizePhone", () => {
  it("accepts E.164 format", () => {
    const result = normalizePhone("+15551234567");
    expect(result.e164).toBe("+15551234567");
    expect(result.warning).toBeNull();
  });

  it("normalizes 10-digit US national format", () => {
    const result = normalizePhone("5551234567");
    expect(result.e164).toBe("+15551234567");
    expect(result.warning).toBeNull();
  });

  it("normalizes formatted US number with dashes", () => {
    const result = normalizePhone("555-123-4567");
    expect(result.e164).toBe("+15551234567");
  });

  it("normalizes 11-digit US format starting with 1", () => {
    const result = normalizePhone("15551234567");
    expect(result.e164).toBe("+15551234567");
  });

  it("returns warning for empty phone", () => {
    const result = normalizePhone("");
    expect(result.e164).toBeNull();
    expect(result.warning).toBe("empty phone");
  });

  it("returns warning for unparseable phone", () => {
    const result = normalizePhone("not-a-phone");
    expect(result.e164).toBeNull();
    expect(result.warning).toMatch(/unparseable/);
  });
});

describe("syncContacts", () => {
  it("calls onPage for each page of contacts", async () => {
    const fakeContacts = Array.from({ length: 3 }, (_, i) => ({
      id: String(i + 1),
      properties: {
        firstname: "Test",
        lastname: `User${i}`,
        phone: `+1555000${i.toString().padStart(4, "0")}`,
        lastmodifieddate: "2026-05-13T12:00:00Z",
      },
    }));

    const client = new FakeHubspotClient();
    client.setResponse("POST", "/crm/v3/objects/contacts/search", {
      results: fakeContacts,
      total: fakeContacts.length,
      // No paging.next → single page
    });

    const pages: unknown[][] = [];
    const result = await syncContacts({
      client,
      tenantId: 1n,
      syncMode: "FULL",
      lastSyncCursor: null,
      syncOverwritesManual: false,
      onPage: async (contacts) => { pages.push(contacts); },
    });

    expect(pages.length).toBe(1);
    expect(pages[0]).toHaveLength(3);
    expect(result.contactsFetched).toBe(3);
    expect(result.lastModifiedDate).toBe("2026-05-13T12:00:00Z");
    expect(result.finalPagingCursor).toBeNull();
  });

  it("paginates across multiple pages", async () => {
    const client = new FakeHubspotClient();

    let callCount = 0;
    // Override post to return paginated responses
    const origPost = client.post.bind(client);
    client.post = async <T>(path: string, body: unknown) => {
      callCount++;
      const fakeContacts = Array.from({ length: callCount < 2 ? 100 : 50 }, (_, i) => ({
        id: String(callCount * 100 + i),
        properties: { lastmodifieddate: "2026-05-13T12:00:00Z" },
      }));
      return {
        data: {
          results: fakeContacts,
          total: 150,
          paging: callCount < 2 ? { next: { after: "cursor-page-2" } } : undefined,
        } as T,
        rateLimitDailyRemaining: 50000,
        rateLimitSecondlyRemaining: 100,
      };
    };
    void origPost; // suppress unused

    let totalContacts = 0;
    const result = await syncContacts({
      client,
      tenantId: 1n,
      syncMode: "FULL",
      lastSyncCursor: null,
      syncOverwritesManual: false,
      onPage: async (contacts) => { totalContacts += contacts.length; },
    });

    expect(callCount).toBe(2);
    expect(result.contactsFetched).toBe(150);
    expect(totalContacts).toBe(150);
  });

  it("passes incremental filter when cursor is set", async () => {
    const client = new FakeHubspotClient();
    const capturedBodies: unknown[] = [];
    client.post = async <T>(path: string, body: unknown) => {
      capturedBodies.push(body);
      return {
        data: { results: [], total: 0 } as T,
        rateLimitDailyRemaining: 50000,
        rateLimitSecondlyRemaining: 100,
      };
    };

    const cursor = new Date("2026-05-01T00:00:00Z");
    await syncContacts({
      client,
      tenantId: 1n,
      syncMode: "INCREMENTAL",
      lastSyncCursor: cursor,
      syncOverwritesManual: false,
      onPage: async () => {},
    });

    expect(capturedBodies.length).toBeGreaterThan(0);
    const body = capturedBodies[0] as { filterGroups?: unknown[] };
    expect(body.filterGroups).toBeDefined();
    expect(body.filterGroups!.length).toBeGreaterThan(0);
  });
});
