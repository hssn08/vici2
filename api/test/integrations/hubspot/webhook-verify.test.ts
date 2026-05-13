import { describe, expect, it } from "vitest";
import { verifyHubspotWebhookSignature } from "../../../src/integrations/hubspot/webhook-verify.js";
import { createHash } from "node:crypto";

const SECRET = "test-client-secret-abc123";

function makeSignature(secret: string, body: string): string {
  return createHash("sha256").update(secret + body).digest("hex");
}

describe("verifyHubspotWebhookSignature", () => {
  it("returns true for a valid signature", () => {
    const body = '[{"eventId":1,"portalId":123}]';
    const sig = makeSignature(SECRET, body);
    expect(verifyHubspotWebhookSignature(SECRET, body, sig)).toBe(true);
  });

  it("returns false for a tampered body", () => {
    const body = '[{"eventId":1,"portalId":123}]';
    const sig = makeSignature(SECRET, body);
    const tamperedBody = '[{"eventId":1,"portalId":999}]'; // different portalId
    expect(verifyHubspotWebhookSignature(SECRET, tamperedBody, sig)).toBe(false);
  });

  it("returns false for a wrong secret", () => {
    const body = '[{"eventId":1,"portalId":123}]';
    const sig = makeSignature("wrong-secret", body);
    expect(verifyHubspotWebhookSignature(SECRET, body, sig)).toBe(false);
  });

  it("returns false for an empty signature", () => {
    const body = '{"x":1}';
    expect(verifyHubspotWebhookSignature(SECRET, body, "")).toBe(false);
  });

  it("returns false for an empty secret", () => {
    const body = '{"x":1}';
    const sig = makeSignature("", body);
    expect(verifyHubspotWebhookSignature("", body, sig)).toBe(false);
  });

  it("accepts Buffer raw body", () => {
    const body = '{"test":true}';
    const sig = makeSignature(SECRET, body);
    expect(verifyHubspotWebhookSignature(SECRET, Buffer.from(body, "utf-8"), sig)).toBe(true);
  });
});
