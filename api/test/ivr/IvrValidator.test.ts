// I02 — IvrValidator unit tests.
// Tests: cycle detection, missing sentinel edges, depth cap, valid trees.

import { describe, it, expect } from "vitest";
import { validateIvrGraph, IvrValidationError } from "../../src/services/ivr/IvrValidator.js";
import type { IvrGraph, ValidatorNode, ValidatorEdge } from "../../src/services/ivr/IvrValidator.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function node(id: number, type: ValidatorNode["nodeType"] = "collect"): ValidatorNode {
  return { id: BigInt(id), nodeType: type };
}

function edge(from: number, input: string, to: number | null = null): ValidatorEdge {
  return { fromNodeId: BigInt(from), onInput: input, toNodeId: to !== null ? BigInt(to) : null };
}

function collectEdges(from: number, toTimeout: number, toInvalid: number, ...digitEdges: [string, number][]): ValidatorEdge[] {
  return [
    ...digitEdges.map(([digit, to]) => edge(from, digit, to)),
    edge(from, "__TIMEOUT__", toTimeout),
    edge(from, "__INVALID_MAX__", toInvalid),
  ];
}

// ─── Valid trees ──────────────────────────────────────────────────────────────

describe("IvrValidator — valid trees", () => {
  it("accepts minimal valid tree: 1 collect + 1 terminal_ingroup", () => {
    const graph: IvrGraph = {
      entryNodeId: BigInt(1),
      nodes: [
        node(1, "collect"),
        node(2, "terminal_ingroup"),
      ],
      edges: [
        ...collectEdges(1, 2, 2, ["1", 2]),
      ],
    };
    const result = validateIvrGraph(graph);
    expect(result.maxDepth).toBe(1);
  });

  it("accepts 2-level tree", () => {
    const graph: IvrGraph = {
      entryNodeId: BigInt(1),
      nodes: [
        node(1, "collect"),         // main menu
        node(2, "collect"),         // sales submenu
        node(3, "terminal_ingroup"), // sales queue
        node(4, "terminal_hangup"),  // hangup
      ],
      edges: [
        ...collectEdges(1, 4, 4, ["1", 2], ["2", 3]),
        ...collectEdges(2, 4, 3, ["1", 3]),
      ],
    };
    const result = validateIvrGraph(graph);
    expect(result.maxDepth).toBe(2);
  });

  it("accepts lang_select node with required sentinel edges", () => {
    const graph: IvrGraph = {
      entryNodeId: BigInt(1),
      nodes: [
        node(1, "lang_select"),
        node(2, "terminal_ingroup"),
        node(3, "terminal_hangup"),
      ],
      edges: [
        ...collectEdges(1, 3, 3, ["1", 2], ["2", 2]),
      ],
    };
    expect(() => validateIvrGraph(graph)).not.toThrow();
  });

  it("accepts exactly 3-level tree (Phase 1 cap)", () => {
    const graph: IvrGraph = {
      entryNodeId: BigInt(1),
      nodes: [
        node(1, "collect"),
        node(2, "collect"),
        node(3, "collect"),
        node(4, "terminal_ingroup"),
        node(5, "terminal_hangup"),
      ],
      edges: [
        ...collectEdges(1, 5, 5, ["1", 2]),
        ...collectEdges(2, 5, 5, ["1", 3]),
        ...collectEdges(3, 5, 5, ["1", 4]),
      ],
    };
    const result = validateIvrGraph(graph);
    expect(result.maxDepth).toBe(3);
  });
});

// ─── Invalid trees ────────────────────────────────────────────────────────────

describe("IvrValidator — invalid trees", () => {
  it("rejects tree with no nodes", () => {
    const graph: IvrGraph = { entryNodeId: null, nodes: [], edges: [] };
    expect(() => validateIvrGraph(graph)).toThrow(IvrValidationError);
  });

  it("rejects tree with no entry node set", () => {
    const graph: IvrGraph = {
      entryNodeId: null,
      nodes: [node(1, "collect")],
      edges: [],
    };
    expect(() => validateIvrGraph(graph)).toThrow(/entry node/i);
  });

  it("rejects collect node missing __TIMEOUT__ edge", () => {
    const graph: IvrGraph = {
      entryNodeId: BigInt(1),
      nodes: [node(1, "collect"), node(2, "terminal_hangup")],
      edges: [
        edge(1, "1", 2),
        edge(1, "__INVALID_MAX__", 2),
        // __TIMEOUT__ missing
      ],
    };
    expect(() => validateIvrGraph(graph)).toThrow(/__TIMEOUT__/);
  });

  it("rejects collect node missing __INVALID_MAX__ edge", () => {
    const graph: IvrGraph = {
      entryNodeId: BigInt(1),
      nodes: [node(1, "collect"), node(2, "terminal_hangup")],
      edges: [
        edge(1, "1", 2),
        edge(1, "__TIMEOUT__", 2),
        // __INVALID_MAX__ missing
      ],
    };
    expect(() => validateIvrGraph(graph)).toThrow(/__INVALID_MAX__/);
  });

  it("rejects terminal node with outgoing edges", () => {
    const graph: IvrGraph = {
      entryNodeId: BigInt(1),
      nodes: [
        node(1, "collect"),
        node(2, "terminal_ingroup"),
      ],
      edges: [
        ...collectEdges(1, 2, 2, ["1", 2]),
        edge(2, "1", 1), // terminal node has outgoing edge!
      ],
    };
    expect(() => validateIvrGraph(graph)).toThrow(/terminal node/i);
  });

  it("rejects tree with cycle (A → B → A)", () => {
    const graph: IvrGraph = {
      entryNodeId: BigInt(1),
      nodes: [
        node(1, "collect"),
        node(2, "collect"),
      ],
      edges: [
        edge(1, "1", 2),
        edge(1, "__TIMEOUT__", 1),
        edge(1, "__INVALID_MAX__", 1),
        edge(2, "1", 1),  // cycle: 2 → 1
        edge(2, "__TIMEOUT__", 1),
        edge(2, "__INVALID_MAX__", 1),
      ],
    };
    expect(() => validateIvrGraph(graph)).toThrow(/cycle/i);
  });

  it("rejects tree with depth > 3 (Phase 1 cap)", () => {
    // 4-level linear chain
    const graph: IvrGraph = {
      entryNodeId: BigInt(1),
      nodes: [
        node(1, "collect"),
        node(2, "collect"),
        node(3, "collect"),
        node(4, "collect"),
        node(5, "terminal_ingroup"),
        node(6, "terminal_hangup"),
      ],
      edges: [
        ...collectEdges(1, 6, 6, ["1", 2]),
        ...collectEdges(2, 6, 6, ["1", 3]),
        ...collectEdges(3, 6, 6, ["1", 4]),
        ...collectEdges(4, 6, 6, ["1", 5]),
      ],
    };
    expect(() => validateIvrGraph(graph)).toThrow(/depth/i);
  });

  it("rejects edge referencing non-existent from_node", () => {
    const graph: IvrGraph = {
      entryNodeId: BigInt(1),
      nodes: [node(1, "collect"), node(2, "terminal_hangup")],
      edges: [
        ...collectEdges(1, 2, 2, ["1", 2]),
        edge(99, "1", 2), // node 99 doesn't exist
      ],
    };
    expect(() => validateIvrGraph(graph)).toThrow(/from_node_id/);
  });

  it("rejects edge referencing non-existent to_node", () => {
    const graph: IvrGraph = {
      entryNodeId: BigInt(1),
      nodes: [node(1, "collect"), node(2, "terminal_hangup")],
      edges: [
        edge(1, "1", 99), // node 99 doesn't exist
        edge(1, "__TIMEOUT__", 2),
        edge(1, "__INVALID_MAX__", 2),
      ],
    };
    expect(() => validateIvrGraph(graph)).toThrow(/to_node_id/);
  });
});
