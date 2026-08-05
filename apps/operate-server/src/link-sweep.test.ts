import type { Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import {
  formatSweepReport,
  relationPairsFromManifest,
  sweepDanglingLinks,
  type DanglingLinkPruner,
} from "./link-sweep.js";

function m2mManifest(rels: ReadonlyArray<{ left: string; right: string }>): Manifest {
  return { relations: rels.map((r) => ({ kind: "many_to_many", ...r })) } as unknown as Manifest;
}

describe("relationPairsFromManifest", () => {
  it("yields one canonical pair per m2m relation (both directions de-duped)", () => {
    const pairs = relationPairsFromManifest(m2mManifest([{ left: "Product", right: "Tag" }]));
    expect(pairs).toEqual([{ left: "Product", right: "Tag" }]);
  });

  it("yields one pair for a self-relation", () => {
    const pairs = relationPairsFromManifest(m2mManifest([{ left: "Person", right: "Person" }]));
    expect(pairs).toEqual([{ left: "Person", right: "Person" }]);
  });

  it("covers multiple relations and ignores non-m2m", () => {
    const manifest = {
      relations: [
        { kind: "many_to_many", left: "Product", right: "Tag" },
        { kind: "many_to_one", left: "Order", right: "Customer" },
        { kind: "many_to_many", left: "Store", right: "Region" },
      ],
    } as unknown as Manifest;
    expect(relationPairsFromManifest(manifest)).toEqual([
      { left: "Product", right: "Tag" },
      { left: "Store", right: "Region" },
    ]);
  });

  it("is empty when the manifest declares no m2m relations", () => {
    expect(relationPairsFromManifest(m2mManifest([]))).toEqual([]);
  });
});

/** A fake pruner that records its calls and returns canned per-relation counts. */
function fakePruner(counts: Record<string, { pruned: number; kept: number }>): {
  pruner: DanglingLinkPruner;
  calls: Array<{ tenantId: string; left: string; right: string }>;
} {
  const calls: Array<{ tenantId: string; left: string; right: string }> = [];
  const pruner: DanglingLinkPruner = {
    pruneDanglingLinks: async (tenantId, left, right) => {
      calls.push({ tenantId, left, right });
      return counts[`${left} ${right}`] ?? { pruned: 0, kept: 0 };
    },
  };
  return { pruner, calls };
}

const TENANT = "00000000-0000-4000-8000-000000000001";

describe("sweepDanglingLinks", () => {
  it("prunes each relation and aggregates the totals", async () => {
    const { pruner, calls } = fakePruner({
      "Product Tag": { pruned: 2, kept: 5 },
      "Store Region": { pruned: 1, kept: 3 },
    });
    const report = await sweepDanglingLinks(
      pruner,
      [
        { left: "Product", right: "Tag" },
        { left: "Store", right: "Region" },
      ],
      TENANT,
    );
    expect(calls).toEqual([
      { tenantId: TENANT, left: "Product", right: "Tag" },
      { tenantId: TENANT, left: "Store", right: "Region" },
    ]);
    expect(report.relations).toEqual([
      { left: "Product", right: "Tag", pruned: 2, kept: 5 },
      { left: "Store", right: "Region", pruned: 1, kept: 3 },
    ]);
    expect(report.totalPruned).toBe(3);
    expect(report.totalKept).toBe(8);
  });

  it("returns an empty report for no relations without touching the pruner", async () => {
    const { pruner, calls } = fakePruner({});
    const report = await sweepDanglingLinks(pruner, [], TENANT);
    expect(calls).toHaveLength(0);
    expect(report).toEqual({ relations: [], totalPruned: 0, totalKept: 0 });
  });
});

describe("formatSweepReport", () => {
  it("prints one line per relation plus a total", () => {
    const out = formatSweepReport({
      relations: [
        { left: "Product", right: "Tag", pruned: 2, kept: 5 },
        { left: "Store", right: "Region", pruned: 0, kept: 3 },
      ],
      totalPruned: 2,
      totalKept: 8,
    });
    expect(out).toContain("Product ↔ Tag: pruned 2, kept 5");
    expect(out).toContain("Store ↔ Region: pruned 0, kept 3");
    expect(out).toContain("total: pruned 2, kept 8");
  });

  it("reports when there is nothing to sweep", () => {
    expect(formatSweepReport({ relations: [], totalPruned: 0, totalKept: 0 })).toBe(
      "no many_to_many relations to sweep\n",
    );
  });
});
