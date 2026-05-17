import { describe, expect, it } from "vitest";
import type { LineageEdge } from "./edges.js";
import type { LineageNode } from "./nodes.js";
import {
  buildLineageGraph,
  computeImpactedDescendants,
  computeSubjectImpact,
  findAncestors,
  findDescendants,
  findLeafNodes,
  findRootNodes,
  findShortestPath,
  hasCycle,
} from "./graph.js";

const makeNode = (id: string, classification: LineageNode["classification"] = "internal"): LineageNode => ({
  id,
  tenantId: "11111111-1111-1111-1111-111111111111",
  kind: "derived_table",
  label: id,
  status: "active",
  classification,
  rowCount: null,
  columnCount: null,
  sizeBytes: null,
  contentSha256: null,
  storageUri: null,
  externalRef: null,
  sourcePackage: null,
  createdAt: "2026-05-16T10:00:00.000Z",
  createdByUserId: "22222222-2222-2222-2222-222222222222",
  createdBySystem: null,
  frozenAt: null,
  frozenSha256: null,
  purgedAt: null,
  tombstonedAt: null,
  retentionUntil: null,
  minimumKAnonymity: null,
});

const makeEdge = (
  id: string,
  source: string,
  target: string,
): LineageEdge => ({
  id,
  tenantId: "11111111-1111-1111-1111-111111111111",
  kind: "derived_from",
  sourceNodeId: source,
  targetNodeId: target,
  sourceClassification: "internal",
  targetClassification: "internal",
  columnsContributing: [],
  columnsConsumed: [],
  transformExpressionSha256: null,
  rowCountConsumed: null,
  rowCountProduced: null,
  kAnonymityAchieved: null,
  redactionRules: [],
  provenanceRecordId: null,
  createdAt: "2026-05-16T10:00:00.000Z",
  createdByUserId: "22222222-2222-2222-2222-222222222222",
  createdBySystem: null,
});

// Build a small lineage:
//   src_a → derived_b → report_c
//   src_a → ml_d → eval_e
//   isolated_f
const nodes: LineageNode[] = [
  makeNode("lng_src_a0001", "pii_personal"),
  makeNode("lng_drvd_b0001"),
  makeNode("lng_rpt_c0001"),
  makeNode("lng_mod_d0001"),
  makeNode("lng_evl_e0001"),
  makeNode("lng_iso_f0001"),
];

const edges: LineageEdge[] = [
  makeEdge("lne_aa_bb0001", "lng_src_a0001", "lng_drvd_b0001"),
  makeEdge("lne_bb_cc0001", "lng_drvd_b0001", "lng_rpt_c0001"),
  makeEdge("lne_aa_dd0001", "lng_src_a0001", "lng_mod_d0001"),
  makeEdge("lne_dd_ee0001", "lng_mod_d0001", "lng_evl_e0001"),
];

describe("buildLineageGraph", () => {
  it("indexes nodes by id and edges by source/target", () => {
    const g = buildLineageGraph(nodes, edges);
    expect(g.nodes.size).toBe(6);
    expect(g.edges).toHaveLength(4);
    expect(g.edgesBySource.get("lng_src_a0001")).toHaveLength(2);
    expect(g.edgesByTarget.get("lng_rpt_c0001")).toHaveLength(1);
  });
});

describe("findAncestors", () => {
  it("returns all upstream nodes of report_c", () => {
    const g = buildLineageGraph(nodes, edges);
    const a = findAncestors(g, "lng_rpt_c0001");
    expect(a.has("lng_drvd_b0001")).toBe(true);
    expect(a.has("lng_src_a0001")).toBe(true);
    expect(a.has("lng_mod_d0001")).toBe(false);
  });

  it("returns empty for root node", () => {
    const g = buildLineageGraph(nodes, edges);
    expect(findAncestors(g, "lng_src_a0001").size).toBe(0);
  });
});

describe("findDescendants", () => {
  it("returns all downstream nodes of src_a", () => {
    const g = buildLineageGraph(nodes, edges);
    const d = findDescendants(g, "lng_src_a0001");
    expect(d.has("lng_drvd_b0001")).toBe(true);
    expect(d.has("lng_rpt_c0001")).toBe(true);
    expect(d.has("lng_mod_d0001")).toBe(true);
    expect(d.has("lng_evl_e0001")).toBe(true);
    expect(d.has("lng_iso_f0001")).toBe(false);
  });

  it("returns empty for leaf node", () => {
    const g = buildLineageGraph(nodes, edges);
    expect(findDescendants(g, "lng_rpt_c0001").size).toBe(0);
  });
});

describe("findShortestPath", () => {
  it("returns single-node path when from === to", () => {
    const g = buildLineageGraph(nodes, edges);
    expect(findShortestPath(g, "lng_src_a0001", "lng_src_a0001")).toEqual([
      "lng_src_a0001",
    ]);
  });

  it("returns 3-hop path from src_a to rpt_c", () => {
    const g = buildLineageGraph(nodes, edges);
    const path = findShortestPath(g, "lng_src_a0001", "lng_rpt_c0001");
    expect(path).toEqual([
      "lng_src_a0001",
      "lng_drvd_b0001",
      "lng_rpt_c0001",
    ]);
  });

  it("returns null when no path exists", () => {
    const g = buildLineageGraph(nodes, edges);
    expect(
      findShortestPath(g, "lng_rpt_c0001", "lng_src_a0001"),
    ).toBeNull();
  });
});

describe("hasCycle", () => {
  it("returns false for DAG", () => {
    const g = buildLineageGraph(nodes, edges);
    expect(hasCycle(g)).toBe(false);
  });

  it("returns true when a cycle is introduced", () => {
    const cyclicEdges = [
      ...edges,
      makeEdge("lne_cc_aa0001", "lng_rpt_c0001", "lng_src_a0001"),
    ];
    const g = buildLineageGraph(nodes, cyclicEdges);
    expect(hasCycle(g)).toBe(true);
  });
});

describe("findRootNodes and findLeafNodes", () => {
  it("identifies roots (no incoming) and leaves (no outgoing)", () => {
    const g = buildLineageGraph(nodes, edges);
    const roots = findRootNodes(g);
    const leaves = findLeafNodes(g);
    expect(roots).toContain("lng_src_a0001");
    expect(roots).toContain("lng_iso_f0001");
    expect(leaves).toContain("lng_rpt_c0001");
    expect(leaves).toContain("lng_evl_e0001");
    expect(leaves).toContain("lng_iso_f0001");
  });
});

describe("computeImpactedDescendants", () => {
  it("returns the union of descendants for changed nodes", () => {
    const g = buildLineageGraph(nodes, edges);
    const impacted = computeImpactedDescendants(g, ["lng_drvd_b0001"]);
    expect(impacted.has("lng_drvd_b0001")).toBe(true);
    expect(impacted.has("lng_rpt_c0001")).toBe(true);
    expect(impacted.has("lng_mod_d0001")).toBe(false);
  });
});

describe("computeSubjectImpact", () => {
  it("returns direct + derived nodes with regulated counts", () => {
    const g = buildLineageGraph(nodes, edges);
    const r = computeSubjectImpact(g, ["lng_src_a0001"]);
    expect(r.directNodes).toEqual(["lng_src_a0001"]);
    expect(r.derivedNodes.length).toBe(4);
    expect(r.totalNodeCount).toBe(5);
    expect(r.regulatedNodeCount).toBe(1);
  });
});
