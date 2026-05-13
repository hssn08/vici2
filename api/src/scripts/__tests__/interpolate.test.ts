// S03 — Interpolation engine unit tests.
//
// Run: pnpm test (vitest)
// No database required.

import { describe, it, expect, vi } from "vitest";
import { interpolate, extractVariables } from "../interpolate.js";

// ---------------------------------------------------------------------------
// Mock libphonenumber-js to avoid importing the big library in tests
// ---------------------------------------------------------------------------

vi.mock("libphonenumber-js/min", () => ({
  parsePhoneNumberFromString: (num: string) => {
    if (num === "+15551234567") {
      return { formatNational: () => "(555) 123-4567" };
    }
    return undefined;
  },
}));

describe("interpolate — known tokens", () => {
  it("replaces {lead.first_name}", () => {
    const out = interpolate("<p>Hello {lead.first_name}!</p>", { firstName: "Alice" });
    expect(out).toBe("<p>Hello Alice!</p>");
  });

  it("replaces {lead.last_name}", () => {
    const out = interpolate("{lead.last_name}", { lastName: "Smith" });
    expect(out).toBe("Smith");
  });

  it("replaces {lead.phone_formatted} with formatted national number", () => {
    const out = interpolate("{lead.phone_formatted}", { phoneE164: "+15551234567" });
    expect(out).toBe("(555) 123-4567");
  });

  it("replaces {lead.email}", () => {
    const out = interpolate("{lead.email}", { email: "test@example.com" });
    expect(out).toBe("test@example.com");
  });

  it("replaces {lead.city}", () => {
    const out = interpolate("{lead.city}", { city: "Austin" });
    expect(out).toBe("Austin");
  });

  it("replaces {lead.state}", () => {
    const out = interpolate("{lead.state}", { state: "TX" });
    expect(out).toBe("TX");
  });

  it("replaces {agent.name}", () => {
    const out = interpolate("{agent.name}", {}, { name: "Bob Jones" });
    expect(out).toBe("Bob Jones");
  });

  it("replaces {campaign.name}", () => {
    const out = interpolate("{campaign.name}", {}, { name: "" }, { name: "Summer Campaign" });
    expect(out).toBe("Summer Campaign");
  });

  it("replaces multiple tokens in one body", () => {
    const body = "Hi {lead.first_name} {lead.last_name}, this is {agent.name}.";
    const out = interpolate(
      body,
      { firstName: "Alice", lastName: "Smith" },
      { name: "Bob" },
    );
    expect(out).toBe("Hi Alice Smith, this is Bob.");
  });
});

describe("interpolate — lead.custom.* tokens", () => {
  it("resolves {lead.custom.account_number}", () => {
    const out = interpolate(
      "Account: {lead.custom.account_number}",
      { customData: { account_number: "ACC-001" } },
    );
    expect(out).toBe("Account: ACC-001");
  });

  it("returns empty string for missing custom key in render mode", () => {
    const out = interpolate(
      "{lead.custom.missing_field}",
      { customData: {} },
      undefined,
      undefined,
      undefined,
      { mode: "render" },
    );
    expect(out).toBe("");
  });

  it("preserves token for missing custom key in preview mode", () => {
    const out = interpolate(
      "{lead.custom.missing_field}",
      { customData: {} },
      undefined,
      undefined,
      undefined,
      { mode: "preview" },
    );
    expect(out).toBe("{lead.custom.missing_field}");
  });
});

describe("interpolate — unknown tokens", () => {
  it("replaces unknown token with empty string in render mode", () => {
    const out = interpolate("{unknown.token}", {}, undefined, undefined, undefined, {
      mode: "render",
    });
    expect(out).toBe("");
  });

  it("preserves unknown token in preview mode", () => {
    const out = interpolate("{unknown.token}", {}, undefined, undefined, undefined, {
      mode: "preview",
    });
    expect(out).toBe("{unknown.token}");
  });
});

describe("interpolate — empty / null lead", () => {
  it("handles null firstName gracefully", () => {
    const out = interpolate("{lead.first_name}", { firstName: null });
    expect(out).toBe("");
  });

  it("handles undefined email gracefully", () => {
    const out = interpolate("{lead.email}", { email: undefined });
    expect(out).toBe("");
  });

  it("handles empty lead object", () => {
    const out = interpolate(
      "{lead.first_name} {lead.last_name}",
      {},
    );
    expect(out).toBe(" ");
  });
});

describe("interpolate — XSS in values", () => {
  it("HTML-escapes < in lead values", () => {
    const out = interpolate("{lead.first_name}", { firstName: "<script>alert(1)</script>" });
    expect(out).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("HTML-escapes & in campaign name", () => {
    const out = interpolate("{campaign.name}", {}, { name: "" }, { name: "AT&T Campaign" });
    expect(out).toBe("AT&amp;T Campaign");
  });

  it("HTML-escapes quotes in agent name", () => {
    const out = interpolate("{agent.name}", {}, { name: 'Bob "The Agent"' });
    expect(out).toBe("Bob &quot;The Agent&quot;");
  });
});

describe("interpolate — call.duration", () => {
  it("formats duration as MM:SS", () => {
    // Freeze time: 90 seconds ago
    const start = new Date(Date.now() - 90_000).toISOString();
    const out = interpolate("{call.duration}", {}, undefined, undefined, { startedAt: start });
    // Allow ±2s slop for test execution time
    expect(out).toMatch(/^0[12]:[23]\d$/);
  });

  it("returns 00:00 when no start time", () => {
    const out = interpolate("{call.duration}", {}, undefined, undefined, {});
    expect(out).toBe("00:00");
  });
});

describe("extractVariables", () => {
  it("returns unique tokens found in body", () => {
    const body = "Hello {lead.first_name} {lead.first_name} and {agent.name}!";
    const vars = extractVariables(body);
    expect(vars).toEqual(["agent.name", "lead.first_name"]);
  });

  it("returns empty array for body with no tokens", () => {
    expect(extractVariables("<p>No tokens here.</p>")).toEqual([]);
  });

  it("handles custom tokens", () => {
    const vars = extractVariables("{lead.custom.acct_num} {lead.state}");
    expect(vars).toContain("lead.custom.acct_num");
    expect(vars).toContain("lead.state");
  });
});
