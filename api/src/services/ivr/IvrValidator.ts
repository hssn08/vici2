// I02 — IVR tree validator.
//
// Enforces:
//   1. No cycles (DFS)
//   2. Every collect/lang_select node has __TIMEOUT__ and __INVALID_MAX__ edges
//   3. Depth ≤ 3 (Phase 1 cap)
//   4. All edges reference nodes within the same IVR
//   5. Terminal nodes have no outgoing edges

import { TERMINAL_NODE_TYPES } from "@vici2/types";
import type { IvrNodeType } from "@vici2/types";

export class IvrValidationError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "IvrValidationError";
  }
}

export interface ValidatorNode {
  id: bigint;
  nodeType: IvrNodeType;
}

export interface ValidatorEdge {
  fromNodeId: bigint;
  onInput: string;
  toNodeId: bigint | null;
}

export interface IvrGraph {
  entryNodeId: bigint | null;
  nodes: ValidatorNode[];
  edges: ValidatorEdge[];
}

const PHASE1_MAX_DEPTH = 3;

export function validateIvrGraph(graph: IvrGraph): { maxDepth: number } {
  const { entryNodeId, nodes, edges } = graph;

  if (nodes.length === 0) {
    throw new IvrValidationError("IVR has no nodes");
  }

  if (!entryNodeId) {
    throw new IvrValidationError("IVR has no entry node set");
  }

  const nodeMap = new Map<bigint, ValidatorNode>();
  for (const n of nodes) {
    nodeMap.set(n.id, n);
  }

  if (!nodeMap.has(entryNodeId)) {
    throw new IvrValidationError(
      `Entry node ${entryNodeId} not found in node list`,
    );
  }

  // Build adjacency map: nodeId → outgoing edges
  const adjacency = new Map<bigint, ValidatorEdge[]>();
  for (const n of nodes) {
    adjacency.set(n.id, []);
  }
  for (const e of edges) {
    if (!nodeMap.has(e.fromNodeId)) {
      throw new IvrValidationError(
        `Edge references unknown from_node_id ${e.fromNodeId}`,
      );
    }
    if (e.toNodeId !== null && !nodeMap.has(e.toNodeId)) {
      throw new IvrValidationError(
        `Edge references unknown to_node_id ${e.toNodeId}`,
      );
    }
    adjacency.get(e.fromNodeId)!.push(e);
  }

  // Validate each non-terminal node has required sentinel edges
  for (const node of nodes) {
    if (!TERMINAL_NODE_TYPES.has(node.nodeType)) {
      const outgoing = adjacency.get(node.id) ?? [];
      const inputs = new Set(outgoing.map((e) => e.onInput));
      if (!inputs.has("__TIMEOUT__")) {
        throw new IvrValidationError(
          `Node ${node.id} (${node.nodeType}) is missing __TIMEOUT__ edge`,
        );
      }
      if (!inputs.has("__INVALID_MAX__")) {
        throw new IvrValidationError(
          `Node ${node.id} (${node.nodeType}) is missing __INVALID_MAX__ edge`,
        );
      }
    } else {
      // Terminal nodes must have no outgoing edges
      const outgoing = adjacency.get(node.id) ?? [];
      if (outgoing.length > 0) {
        throw new IvrValidationError(
          `Terminal node ${node.id} (${node.nodeType}) has outgoing edges — not allowed`,
        );
      }
    }
  }

  // DFS: cycle detection + max depth
  const WHITE = 0; // unvisited
  const GRAY = 1;  // in current path
  const BLACK = 2; // fully visited

  const color = new Map<bigint, number>();
  for (const n of nodes) {
    color.set(n.id, WHITE);
  }

  let maxDepth = 0;

  function dfs(nodeId: bigint, depth: number): void {
    color.set(nodeId, GRAY);
    maxDepth = Math.max(maxDepth, depth);

    if (depth > PHASE1_MAX_DEPTH) {
      throw new IvrValidationError(
        `IVR tree depth ${depth} exceeds Phase 1 cap of ${PHASE1_MAX_DEPTH}`,
      );
    }

    const outgoing = adjacency.get(nodeId) ?? [];
    for (const edge of outgoing) {
      if (edge.toNodeId === null) continue;
      const c = color.get(edge.toNodeId);
      if (c === GRAY) {
        throw new IvrValidationError(
          `IVR tree has a cycle: node ${nodeId} → node ${edge.toNodeId}`,
        );
      }
      if (c === WHITE) {
        dfs(edge.toNodeId, depth + 1);
      }
    }

    color.set(nodeId, BLACK);
  }

  dfs(entryNodeId, 0);

  // Check for unreachable nodes (warn but don't fail — orphan nodes are OK)
  // Phase 2: flag orphans.

  return { maxDepth };
}
