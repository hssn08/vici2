// I02 — XmlBuilder unit tests.
// Tests: XML generation for all node types, lang conditions, terminal actions.

import { describe, it, expect } from "vitest";
import { buildDefaultContextXml, buildPublicContextXml } from "../../src/services/ivr/XmlBuilder.js";
import type { BuilderIvr, BuilderDid } from "../../src/services/ivr/XmlBuilder.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeCollectNode(id: number, overrides: Partial<BuilderIvr["nodes"][0]> = {}): BuilderIvr["nodes"][0] {
  return {
    id: BigInt(id),
    nodeType: "collect",
    name: `Node ${id}`,
    collectMin: 1,
    collectMax: 1,
    collectTerminators: "none",
    timeoutMs: 5000,
    invalidMax: 3,
    actionTarget: null,
    prompts: [],
    ...overrides,
  };
}

function makeEdge(
  from: number,
  onInput: string,
  to: number | null,
  sortOrder = 0,
): BuilderIvr["edges"][0] {
  return {
    fromNodeId: BigInt(from),
    onInput,
    toNodeId: to !== null ? BigInt(to) : null,
    label: null,
    sortOrder,
  };
}

// ─── collect node XML ─────────────────────────────────────────────────────────

describe("XmlBuilder — collect node", () => {
  it("generates correct extension name", () => {
    const ivr: BuilderIvr = {
      id: BigInt(42),
      entryNodeId: BigInt(1),
      nodes: [
        makeCollectNode(1),
        makeCollectNode(2, { nodeType: "terminal_hangup" }),
      ],
      edges: [
        makeEdge(1, "1", 2, 0),
        makeEdge(1, "__TIMEOUT__", 2, 1),
        makeEdge(1, "__INVALID_MAX__", 2, 2),
      ],
    };
    const xml = buildDefaultContextXml(ivr);
    expect(xml).toContain('name="ivr_42_n1"');
  });

  it("generates read application with correct args", () => {
    const ivr: BuilderIvr = {
      id: BigInt(1),
      entryNodeId: BigInt(1),
      nodes: [
        makeCollectNode(1, { collectMin: 1, collectMax: 1, timeoutMs: 5000 }),
        makeCollectNode(2, { nodeType: "terminal_hangup" }),
      ],
      edges: [
        makeEdge(1, "1", 2),
        makeEdge(1, "__TIMEOUT__", 2),
        makeEdge(1, "__INVALID_MAX__", 2),
      ],
    };
    const xml = buildDefaultContextXml(ivr);
    expect(xml).toContain("read");
    expect(xml).toContain("5000");
  });

  it("generates branch dispatcher with digit conditions", () => {
    const ivr: BuilderIvr = {
      id: BigInt(1),
      entryNodeId: BigInt(1),
      nodes: [
        makeCollectNode(1),
        makeCollectNode(2, { nodeType: "terminal_ingroup", actionTarget: "SALES" }),
        makeCollectNode(3, { nodeType: "terminal_ingroup", actionTarget: "SUPPORT" }),
        makeCollectNode(4, { nodeType: "terminal_hangup" }),
      ],
      edges: [
        makeEdge(1, "1", 2, 0),
        makeEdge(1, "2", 3, 1),
        makeEdge(1, "__TIMEOUT__", 4, 2),
        makeEdge(1, "__INVALID_MAX__", 4, 3),
      ],
    };
    const xml = buildDefaultContextXml(ivr);
    expect(xml).toContain("ivr_1_n1_branch");
    expect(xml).toContain("^1$");
    expect(xml).toContain("^2$");
    // Timeout edge matches empty string
    expect(xml).toContain("^$");
  });

  it("generates invalid count check extension", () => {
    const ivr: BuilderIvr = {
      id: BigInt(1),
      entryNodeId: BigInt(1),
      nodes: [
        makeCollectNode(1, { invalidMax: 3 }),
        makeCollectNode(2, { nodeType: "terminal_hangup" }),
      ],
      edges: [
        makeEdge(1, "1", 2),
        makeEdge(1, "__TIMEOUT__", 2),
        makeEdge(1, "__INVALID_MAX__", 2),
      ],
    };
    const xml = buildDefaultContextXml(ivr);
    expect(xml).toContain("ivr_1_n1_invalid_check");
    expect(xml).toContain("ivr_invalid_count");
  });
});

// ─── terminal nodes ───────────────────────────────────────────────────────────

describe("XmlBuilder — terminal_ingroup", () => {
  it("generates transfer to ingroup_{id}", () => {
    const ivr: BuilderIvr = {
      id: BigInt(5),
      entryNodeId: BigInt(1),
      nodes: [
        makeCollectNode(1),
        makeCollectNode(2, { nodeType: "terminal_ingroup", actionTarget: "SUPPORT" }),
        makeCollectNode(3, { nodeType: "terminal_hangup" }),
      ],
      edges: [
        makeEdge(1, "1", 2),
        makeEdge(1, "__TIMEOUT__", 3),
        makeEdge(1, "__INVALID_MAX__", 3),
      ],
    };
    const xml = buildDefaultContextXml(ivr);
    expect(xml).toContain("transfer");
    expect(xml).toContain("ingroup_SUPPORT");
    expect(xml).toContain("vici2_ivr_exit_action=route_to_ingroup");
    expect(xml).toContain("vici2_ivr_exit_target=SUPPORT");
  });
});

describe("XmlBuilder — terminal_hangup", () => {
  it("generates playback + hangup actions", () => {
    const ivr: BuilderIvr = {
      id: BigInt(1),
      entryNodeId: BigInt(1),
      nodes: [
        makeCollectNode(1),
        makeCollectNode(2, { nodeType: "terminal_hangup" }),
      ],
      edges: [
        makeEdge(1, "1", 2),
        makeEdge(1, "__TIMEOUT__", 2),
        makeEdge(1, "__INVALID_MAX__", 2),
      ],
    };
    const xml = buildDefaultContextXml(ivr);
    expect(xml).toContain('application="playback"');
    expect(xml).toContain("sys_goodbye.wav");
    expect(xml).toContain("NORMAL_CLEARING");
  });
});

describe("XmlBuilder — terminal_voicemail", () => {
  it("generates transfer to voicemail_{id}", () => {
    const ivr: BuilderIvr = {
      id: BigInt(1),
      entryNodeId: BigInt(1),
      nodes: [
        makeCollectNode(1),
        makeCollectNode(2, { nodeType: "terminal_voicemail", actionTarget: "BOX1" }),
        makeCollectNode(3, { nodeType: "terminal_hangup" }),
      ],
      edges: [
        makeEdge(1, "1", 2),
        makeEdge(1, "__TIMEOUT__", 3),
        makeEdge(1, "__INVALID_MAX__", 3),
      ],
    };
    const xml = buildDefaultContextXml(ivr);
    expect(xml).toContain("voicemail_BOX1");
  });
});

describe("XmlBuilder — terminal_transfer", () => {
  it("generates bridge with sofia gateway and E.164 target", () => {
    const ivr: BuilderIvr = {
      id: BigInt(1),
      entryNodeId: BigInt(1),
      nodes: [
        makeCollectNode(1),
        makeCollectNode(2, { nodeType: "terminal_transfer", actionTarget: "+18005551234" }),
        makeCollectNode(3, { nodeType: "terminal_hangup" }),
      ],
      edges: [
        makeEdge(1, "1", 2),
        makeEdge(1, "__TIMEOUT__", 3),
        makeEdge(1, "__INVALID_MAX__", 3),
      ],
    };
    const xml = buildDefaultContextXml(ivr);
    expect(xml).toContain("hangup_after_bridge=true");
    expect(xml).toContain("sofia/gateway");
    expect(xml).toContain("+18005551234");
  });
});

describe("XmlBuilder — terminal_callback", () => {
  it("generates play_and_get_digits + callback dispatch extension", () => {
    const ivr: BuilderIvr = {
      id: BigInt(1),
      entryNodeId: BigInt(1),
      nodes: [
        makeCollectNode(1),
        makeCollectNode(2, { nodeType: "terminal_callback", actionTarget: "SUPPORT" }),
        makeCollectNode(3, { nodeType: "terminal_hangup" }),
      ],
      edges: [
        makeEdge(1, "1", 2),
        makeEdge(1, "__TIMEOUT__", 3),
        makeEdge(1, "__INVALID_MAX__", 3),
      ],
    };
    const xml = buildDefaultContextXml(ivr);
    expect(xml).toContain("play_and_get_digits");
    expect(xml).toContain("sys_callback_offer.wav");
    expect(xml).toContain("ivr_callback_dispatch_2");
    expect(xml).toContain("ingroup_SUPPORT");
  });
});

// ─── lang_select ──────────────────────────────────────────────────────────────

describe("XmlBuilder — lang_select node", () => {
  it("generates language set action on edges", () => {
    const ivr: BuilderIvr = {
      id: BigInt(1),
      entryNodeId: BigInt(1),
      nodes: [
        makeCollectNode(1, { nodeType: "lang_select" }),
        makeCollectNode(2, { nodeType: "terminal_ingroup", actionTarget: "SUPPORT" }),
        makeCollectNode(3, { nodeType: "terminal_hangup" }),
      ],
      edges: [
        makeEdge(1, "1", 2, 0),
        makeEdge(1, "2", 2, 1),
        makeEdge(1, "__TIMEOUT__", 3, 2),
        makeEdge(1, "__INVALID_MAX__", 3, 3),
      ],
    };
    const xml = buildDefaultContextXml(ivr);
    expect(xml).toContain("vici2_ivr_lang=en");
  });
});

// ─── Multi-language prompts ───────────────────────────────────────────────────

describe("XmlBuilder — multi-language prompts", () => {
  it("generates language condition for non-English prompt", () => {
    const ivr: BuilderIvr = {
      id: BigInt(1),
      entryNodeId: BigInt(1),
      nodes: [
        makeCollectNode(1, {
          prompts: [
            { lang: "en", localPath: "/sounds/ivr/t1/1/1_en.wav" },
            { lang: "es", localPath: "/sounds/ivr/t1/1/1_es.wav" },
          ],
        }),
        makeCollectNode(2, { nodeType: "terminal_hangup" }),
      ],
      edges: [
        makeEdge(1, "1", 2),
        makeEdge(1, "__TIMEOUT__", 2),
        makeEdge(1, "__INVALID_MAX__", 2),
      ],
    };
    const xml = buildDefaultContextXml(ivr);
    expect(xml).toContain("^es$");
    expect(xml).toContain("1_es.wav");
    expect(xml).toContain("1_en.wav");
  });
});

// ─── DID public context ───────────────────────────────────────────────────────

describe("XmlBuilder — buildPublicContextXml", () => {
  const ivr: BuilderIvr = {
    id: BigInt(7),
    entryNodeId: BigInt(1),
    nodes: [makeCollectNode(1)],
    edges: [],
  };

  it("generates public context extension for DID e164 digits", () => {
    const did: BuilderDid = {
      e164: "+18005551234",
      e164Digits: "18005551234",
      defaultLang: "en",
      ivrTimeoutSec: 300,
      ivrId: BigInt(7),
      recordingDisclosureAudio: null,
    };
    const xml = buildPublicContextXml(did, ivr);
    expect(xml).toContain('context name="public"');
    expect(xml).toContain("18005551234");
    expect(xml).toContain("vici2_ivr_id=7");
    expect(xml).toContain("vici2_ivr_lang=en");
    expect(xml).toContain("sched_transfer");
    expect(xml).toContain("+300");
  });

  it("includes recording disclosure playback when set", () => {
    const did: BuilderDid = {
      e164: "+18005559999",
      e164Digits: "18005559999",
      defaultLang: "es",
      ivrTimeoutSec: 120,
      ivrId: BigInt(7),
      recordingDisclosureAudio: "/sounds/disclosure.wav",
    };
    const xml = buildPublicContextXml(did, ivr);
    expect(xml).toContain("disclosure.wav");
    expect(xml).toContain("vici2_ivr_lang=es");
  });

  it("omits recording disclosure when null", () => {
    const did: BuilderDid = {
      e164: "+18005550000",
      e164Digits: "18005550000",
      defaultLang: "en",
      ivrTimeoutSec: 300,
      ivrId: BigInt(7),
      recordingDisclosureAudio: null,
    };
    const xml = buildPublicContextXml(did, ivr);
    expect(xml).not.toContain("disclosure");
  });
});
