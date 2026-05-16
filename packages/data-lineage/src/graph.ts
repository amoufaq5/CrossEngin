import type { LineageNode } from "./nodes.js";
import type { LineageEdge } from "./edges.js";

export interface LineageGraph {
  readonly nodes: ReadonlyMap<string, LineageNode>;
  readonly edges: readonly LineageEdge[];
  readonly edgesBySource: ReadonlyMap<string, readonly LineageEdge[]>;
  readonly edgesByTarget: ReadonlyMap<string, readonly LineageEdge[]>;
}

export const buildLineageGraph = (
  nodes: readonly LineageNode[],
  edges: readonly LineageEdge[],
): LineageGraph => {
  const nodeMap = new Map<string, LineageNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  const bySource = new Map<string, LineageEdge[]>();
  const byTarget = new Map<string, LineageEdge[]>();
  for (const e of edges) {
    if (!bySource.has(e.sourceNodeId)) bySource.set(e.sourceNodeId, []);
    if (!byTarget.has(e.targetNodeId)) byTarget.set(e.targetNodeId, []);
    bySource.get(e.sourceNodeId)?.push(e);
    byTarget.get(e.targetNodeId)?.push(e);
  }
  return {
    nodes: nodeMap,
    edges,
    edgesBySource: bySource,
    edgesByTarget: byTarget,
  };
};

export const findAncestors = (
  graph: LineageGraph,
  startNodeId: string,
  maxDepth = 50,
): ReadonlySet<string> => {
  const ancestors = new Set<string>();
  const queue: { id: string; depth: number }[] = [
    { id: startNodeId, depth: 0 },
  ];
  while (queue.length > 0) {
    const { id, depth } = queue.shift() as { id: string; depth: number };
    if (depth >= maxDepth) continue;
    const incoming = graph.edgesByTarget.get(id) ?? [];
    for (const edge of incoming) {
      if (!ancestors.has(edge.sourceNodeId)) {
        ancestors.add(edge.sourceNodeId);
        queue.push({ id: edge.sourceNodeId, depth: depth + 1 });
      }
    }
  }
  return ancestors;
};

export const findDescendants = (
  graph: LineageGraph,
  startNodeId: string,
  maxDepth = 50,
): ReadonlySet<string> => {
  const descendants = new Set<string>();
  const queue: { id: string; depth: number }[] = [
    { id: startNodeId, depth: 0 },
  ];
  while (queue.length > 0) {
    const { id, depth } = queue.shift() as { id: string; depth: number };
    if (depth >= maxDepth) continue;
    const outgoing = graph.edgesBySource.get(id) ?? [];
    for (const edge of outgoing) {
      if (!descendants.has(edge.targetNodeId)) {
        descendants.add(edge.targetNodeId);
        queue.push({ id: edge.targetNodeId, depth: depth + 1 });
      }
    }
  }
  return descendants;
};

export const findShortestPath = (
  graph: LineageGraph,
  fromNodeId: string,
  toNodeId: string,
): readonly string[] | null => {
  if (fromNodeId === toNodeId) return [fromNodeId];
  const visited = new Set<string>([fromNodeId]);
  const queue: { id: string; path: readonly string[] }[] = [
    { id: fromNodeId, path: [fromNodeId] },
  ];
  while (queue.length > 0) {
    const { id, path } = queue.shift() as {
      id: string;
      path: readonly string[];
    };
    const outgoing = graph.edgesBySource.get(id) ?? [];
    for (const edge of outgoing) {
      if (edge.targetNodeId === toNodeId) {
        return [...path, edge.targetNodeId];
      }
      if (!visited.has(edge.targetNodeId)) {
        visited.add(edge.targetNodeId);
        queue.push({
          id: edge.targetNodeId,
          path: [...path, edge.targetNodeId],
        });
      }
    }
  }
  return null;
};

export const hasCycle = (graph: LineageGraph): boolean => {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of graph.nodes.keys()) color.set(id, WHITE);
  const visit = (id: string): boolean => {
    color.set(id, GRAY);
    const outgoing = graph.edgesBySource.get(id) ?? [];
    for (const edge of outgoing) {
      const targetColor = color.get(edge.targetNodeId) ?? WHITE;
      if (targetColor === GRAY) return true;
      if (targetColor === WHITE && visit(edge.targetNodeId)) return true;
    }
    color.set(id, BLACK);
    return false;
  };
  for (const id of graph.nodes.keys()) {
    if (color.get(id) === WHITE && visit(id)) return true;
  }
  return false;
};

export const findRootNodes = (
  graph: LineageGraph,
): readonly string[] => {
  const roots: string[] = [];
  for (const id of graph.nodes.keys()) {
    const incoming = graph.edgesByTarget.get(id);
    if (incoming === undefined || incoming.length === 0) {
      roots.push(id);
    }
  }
  return roots;
};

export const findLeafNodes = (
  graph: LineageGraph,
): readonly string[] => {
  const leaves: string[] = [];
  for (const id of graph.nodes.keys()) {
    const outgoing = graph.edgesBySource.get(id);
    if (outgoing === undefined || outgoing.length === 0) {
      leaves.push(id);
    }
  }
  return leaves;
};

export const computeImpactedDescendants = (
  graph: LineageGraph,
  changedNodeIds: readonly string[],
): ReadonlySet<string> => {
  const impacted = new Set<string>();
  for (const id of changedNodeIds) {
    impacted.add(id);
    for (const desc of findDescendants(graph, id)) {
      impacted.add(desc);
    }
  }
  return impacted;
};

export interface SubjectImpactSummary {
  readonly directNodes: readonly string[];
  readonly derivedNodes: readonly string[];
  readonly totalNodeCount: number;
  readonly regulatedNodeCount: number;
}

export const computeSubjectImpact = (
  graph: LineageGraph,
  subjectNodeIds: readonly string[],
): SubjectImpactSummary => {
  const direct = new Set(subjectNodeIds);
  const derived = new Set<string>();
  for (const nodeId of subjectNodeIds) {
    for (const desc of findDescendants(graph, nodeId)) {
      if (!direct.has(desc)) derived.add(desc);
    }
  }
  let regulatedCount = 0;
  for (const id of [...direct, ...derived]) {
    const node = graph.nodes.get(id);
    if (
      node !== undefined &&
      (node.classification === "pii_personal" ||
        node.classification === "phi_protected" ||
        node.classification === "regulated_financial")
    ) {
      regulatedCount++;
    }
  }
  return {
    directNodes: Array.from(direct),
    derivedNodes: Array.from(derived),
    totalNodeCount: direct.size + derived.size,
    regulatedNodeCount: regulatedCount,
  };
};
