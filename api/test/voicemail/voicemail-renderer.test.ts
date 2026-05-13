// I03 — VoicemailRenderer unit tests.
// Tests: XML generation, file write, reloadxml, inactive box removal.

import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";

// ─── Mock Prisma ──────────────────────────────────────────────────────────────

const mockFindUnique = vi.fn();

vi.mock("../../src/lib/prisma.js", () => ({
  getPrisma: () => ({
    voicemailBox: {
      findUnique: mockFindUnique,
    },
  }),
}));

// ─── Mock ESL client ──────────────────────────────────────────────────────────

const mockBgapi = vi.fn().mockResolvedValue(undefined);

// ─── Setup file system for tests ──────────────────────────────────────────────

import fs from "node:fs/promises";
import { VoicemailRenderer, setEslClient } from "../../src/services/voicemail/VoicemailRenderer.js";
import { getPrisma } from "../../src/lib/prisma.js";

const tmpDir = path.join(os.tmpdir(), `vici2-vm-renderer-test-${process.pid}`);

beforeEach(async () => {
  vi.clearAllMocks();
  mockBgapi.mockResolvedValue(undefined);
  setEslClient({ bgapi: mockBgapi });
  process.env.FS_DIALPLAN_DIR = tmpDir;
  await fs.mkdir(tmpDir, { recursive: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("VoicemailRenderer", () => {
  it("renders XML for an active mailbox with default greeting", async () => {
    mockFindUnique.mockResolvedValue({
      id: BigInt(42),
      tenantId: BigInt(1),
      name: "SUPPORT",
      greetingUri: null,
      maxDurationSec: 90,
      active: true,
    });

    const prisma = getPrisma();
    const renderer = new VoicemailRenderer(prisma);
    await renderer.render(BigInt(42));

    const filePath = path.join(tmpDir, "75_voicemail_42.xml");
    const content = await fs.readFile(filePath, "utf8");

    expect(content).toContain('name="voicemail_42"');
    expect(content).toContain("destination_number");
    expect(content).toContain("^voicemail_42$");
    expect(content).toContain("sys_voicemail_default.wav");
    expect(content).toContain("90"); // max_duration_sec
    expect(content).toContain("tone_stream://%(500,0,440)"); // beep
    expect(content).toContain("record");
    expect(content).toContain("/api/internal/voicemail/recorded");
  });

  it("renders XML with custom greeting when greetingUri is set", async () => {
    const customGreeting = "/var/lib/freeswitch/sounds/voicemail/1/42_greeting.wav";
    mockFindUnique.mockResolvedValue({
      id: BigInt(42),
      tenantId: BigInt(1),
      name: "SUPPORT",
      greetingUri: customGreeting,
      maxDurationSec: 120,
      active: true,
    });

    const prisma = getPrisma();
    const renderer = new VoicemailRenderer(prisma);
    await renderer.render(BigInt(42));

    const filePath = path.join(tmpDir, "75_voicemail_42.xml");
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain(customGreeting);
  });

  it("removes XML file when box is inactive", async () => {
    mockFindUnique.mockResolvedValue({
      id: BigInt(99),
      tenantId: BigInt(1),
      name: "OLD",
      greetingUri: null,
      maxDurationSec: 120,
      active: false,
    });

    const filePath = path.join(tmpDir, "75_voicemail_99.xml");
    // Pre-create the file to ensure it exists before deactivation
    await fs.writeFile(filePath, "<include/>", "utf8");
    // Verify it exists
    await fs.access(filePath); // should not throw

    const prisma = getPrisma();
    const renderer = new VoicemailRenderer(prisma);
    await renderer.render(BigInt(99));

    // File should be gone — stat it and expect ENOENT
    let fileGone = false;
    try {
      await fs.access(filePath);
    } catch {
      fileGone = true;
    }
    expect(fileGone).toBe(true);
  });

  it("calls bgapi reloadxml after render", async () => {
    mockFindUnique.mockResolvedValue({
      id: BigInt(10),
      tenantId: BigInt(1),
      name: "TEST",
      greetingUri: null,
      maxDurationSec: 120,
      active: true,
    });

    const prisma = getPrisma();
    const renderer = new VoicemailRenderer(prisma);
    await renderer.render(BigInt(10));

    expect(mockBgapi).toHaveBeenCalledWith("reloadxml");
  });

  it("calls bgapi reloadxml even when deactivating", async () => {
    mockFindUnique.mockResolvedValue({
      id: BigInt(11),
      tenantId: BigInt(1),
      name: "DEACTIVATED",
      greetingUri: null,
      maxDurationSec: 120,
      active: false,
    });

    const prisma = getPrisma();
    const renderer = new VoicemailRenderer(prisma);
    await renderer.render(BigInt(11));

    expect(mockBgapi).toHaveBeenCalledWith("reloadxml");
  });

  it("throws when mailbox not found", async () => {
    mockFindUnique.mockResolvedValue(null);

    const prisma = getPrisma();
    const renderer = new VoicemailRenderer(prisma);
    await expect(renderer.render(BigInt(999))).rejects.toThrow("not found");
  });

  it("uses tenantId in recording path", async () => {
    mockFindUnique.mockResolvedValue({
      id: BigInt(7),
      tenantId: BigInt(5),
      name: "MULTI-TENANT",
      greetingUri: null,
      maxDurationSec: 60,
      active: true,
    });

    const prisma = getPrisma();
    const renderer = new VoicemailRenderer(prisma);
    await renderer.render(BigInt(7));

    const filePath = path.join(tmpDir, "75_voicemail_7.xml");
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain("vici2_tenant_id=5");
    expect(content).toContain("vici2_vm_box_id=7");
  });

  it("writes file atomically via tmp rename", async () => {
    mockFindUnique.mockResolvedValue({
      id: BigInt(20),
      tenantId: BigInt(1),
      name: "ATOMIC",
      greetingUri: null,
      maxDurationSec: 120,
      active: true,
    });

    const prisma = getPrisma();
    const renderer = new VoicemailRenderer(prisma);
    await renderer.render(BigInt(20));

    // Only the final file should exist, not the .tmp file
    const tmpFilePath = path.join(tmpDir, "75_voicemail_20.xml.tmp");
    await expect(fs.access(tmpFilePath)).rejects.toThrow();

    const filePath = path.join(tmpDir, "75_voicemail_20.xml");
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain('name="voicemail_20"');
  });
});
