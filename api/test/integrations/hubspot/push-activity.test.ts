import { describe, expect, it } from "vitest";
import { pushCallActivity } from "../../../src/integrations/hubspot/push-activity.js";
import { FakeHubspotClient } from "../../../src/integrations/hubspot/hubspot-client.js";

const BASE_OPTS = {
  hsObjectId: "contact-123",
  disposition: "SALE",
  dispositionMap: {},
  durationMs: 125_000,
  fromNumber: "+15558675309",
  toNumber: "+15551234567",
  startedAt: "2026-05-13T21:10:00.000Z",
  callId: "call-uuid-abc",
};

describe("pushCallActivity", () => {
  it("POSTs a new engagement when no preCreatedEngagementId", async () => {
    const client = new FakeHubspotClient();
    client.setResponse("POST", "/crm/v3/objects/calls", { id: "hs-eng-999" });

    const engId = await pushCallActivity({ client, ...BASE_OPTS });
    expect(engId).toBe("hs-eng-999");

    const call = client.calls.find((c) => c.method === "POST" && c.path === "/crm/v3/objects/calls");
    expect(call).toBeDefined();
    const body = call!.body as { properties: { hs_call_status: string }; associations: unknown[] };
    expect(body.properties.hs_call_status).toBe("COMPLETED"); // SALE → COMPLETED
    expect(body.associations).toHaveLength(1);
  });

  it("PATCHes pre-created engagement when preCreatedEngagementId is set", async () => {
    const client = new FakeHubspotClient();
    client.setResponse("PATCH", "/crm/v3/objects/calls/hs-eng-42", { id: "hs-eng-42" });

    const engId = await pushCallActivity({
      client,
      ...BASE_OPTS,
      preCreatedEngagementId: "hs-eng-42",
    });
    expect(engId).toBe("hs-eng-42");

    const call = client.calls.find((c) => c.method === "PATCH");
    expect(call).toBeDefined();
    expect(call!.path).toBe("/crm/v3/objects/calls/hs-eng-42");
  });

  it("maps NA disposition to NO_ANSWER", async () => {
    const client = new FakeHubspotClient();
    client.setResponse("POST", "/crm/v3/objects/calls", { id: "hs-eng-1" });

    await pushCallActivity({ client, ...BASE_OPTS, disposition: "NA" });

    const call = client.calls.find((c) => c.method === "POST");
    const body = call!.body as { properties: { hs_call_status: string } };
    expect(body.properties.hs_call_status).toBe("NO_ANSWER");
  });

  it("includes recording URL when provided", async () => {
    const client = new FakeHubspotClient();
    client.setResponse("POST", "/crm/v3/objects/calls", { id: "hs-eng-2" });

    await pushCallActivity({
      client,
      ...BASE_OPTS,
      recordingUrl: "https://example.com/recordings/abc.mp3",
    });

    const call = client.calls.find((c) => c.method === "POST");
    const body = call!.body as { properties: { hs_call_recording_url?: string } };
    expect(body.properties.hs_call_recording_url).toBe("https://example.com/recordings/abc.mp3");
  });

  it("does not include recording URL when not provided", async () => {
    const client = new FakeHubspotClient();
    client.setResponse("POST", "/crm/v3/objects/calls", { id: "hs-eng-3" });

    await pushCallActivity({ client, ...BASE_OPTS });

    const call = client.calls.find((c) => c.method === "POST");
    const body = call!.body as { properties: { hs_call_recording_url?: string } };
    expect(body.properties.hs_call_recording_url).toBeUndefined();
  });

  it("uses override dispositionMap over defaults", async () => {
    const client = new FakeHubspotClient();
    client.setResponse("POST", "/crm/v3/objects/calls", { id: "hs-eng-4" });

    await pushCallActivity({
      client,
      ...BASE_OPTS,
      disposition: "SALE",
      dispositionMap: { SALE: "BUSY" }, // override: SALE → BUSY
    });

    const call = client.calls.find((c) => c.method === "POST");
    const body = call!.body as { properties: { hs_call_status: string } };
    expect(body.properties.hs_call_status).toBe("BUSY");
  });
});
