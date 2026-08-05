import type { Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import {
  formatMultiTenantReport,
  formatSweepReport,
  relationPairsFromManifest,
  sweepDanglingLinks,
  sweepDanglingLinksForTenants,
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

/** A fake pruner that records its calls (incl. the dryRun opt) and returns canned counts. */
function fakePruner(counts: Record<string, { pruned: number; kept: number }>): {
  pruner: DanglingLinkPruner;
  calls: Array<{ tenantId: string; left: string; right: string; dryRun: boolean }>;
} {
  const calls: Array<{ tenantId: string; left: string; right: string; dryRun: boolean }> = [];
  const pruner: DanglingLinkPruner = {
    pruneDanglingLinks: async (tenantId, left, right, opts) => {
      calls.push({ tenantId, left, right, dryRun: opts?.dryRun === true });
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
      { tenantId: TENANT, left: "Product", right: "Tag", dryRun: false },
      { tenantId: TENANT, left: "Store", right: "Region", dryRun: false },
    ]);
    expect(report.relations).toEqual([
      { left: "Product", right: "Tag", pruned: 2, kept: 5 },
      { left: "Store", right: "Region", pruned: 1, kept: 3 },
    ]);
    expect(report.totalPruned).toBe(3);
    expect(report.totalKept).toBe(8);
  });

  it("threads the dryRun option through to the pruner", async () => {
    const { pruner, calls } = fakePruner({ "Product Tag": { pruned: 1, kept: 0 } });
    await sweepDanglingLinks(pruner, [{ left: "Product", right: "Tag" }], TENANT, { dryRun: true });
    expect(calls[0]?.dryRun).toBe(true);
  });

  it("returns an empty report for no relations without touching the pruner", async () => {
    const { pruner, calls } = fakePruner({});
    const report = await sweepDanglingLinks(pruner, [], TENANT);
    expect(calls).toHaveLength(0);
    expect(report).toEqual({ relations: [], totalPruned: 0, totalKept: 0 });
  });
});

const TENANT_B = "00000000-0000-4000-8000-000000000002";

describe("sweepDanglingLinksForTenants", () => {
  it("sweeps every tenant and aggregates a grand total", async () => {
    const { pruner, calls } = fakePruner({ "Product Tag": { pruned: 2, kept: 4 } });
    const multi = await sweepDanglingLinksForTenants(
      pruner,
      [{ left: "Product", right: "Tag" }],
      [TENANT, TENANT_B],
      { dryRun: false },
    );
    expect(calls.map((c) => c.tenantId)).toEqual([TENANT, TENANT_B]);
    expect(multi.tenants.map((t) => t.tenantId)).toEqual([TENANT, TENANT_B]);
    expect(multi.totalPruned).toBe(4);
    expect(multi.totalKept).toBe(8);
    expect(multi.dryRun).toBe(false);
  });

  it("marks a dry run and threads it to every tenant's sweep", async () => {
    const { pruner, calls } = fakePruner({ "Product Tag": { pruned: 1, kept: 0 } });
    const multi = await sweepDanglingLinksForTenants(pruner, [{ left: "Product", right: "Tag" }], [TENANT], {
      dryRun: true,
    });
    expect(multi.dryRun).toBe(true);
    expect(calls.every((c) => c.dryRun)).toBe(true);
  });

  it("returns an empty multi-report when there are no tenants", async () => {
    const { pruner, calls } = fakePruner({});
    const multi = await sweepDanglingLinksForTenants(pruner, [{ left: "Product", right: "Tag" }], [], {});
    expect(calls).toHaveLength(0);
    expect(multi).toEqual({ tenants: [], totalPruned: 0, totalKept: 0, dryRun: false });
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

describe("formatMultiTenantReport", () => {
  it("prints a per-tenant section, a grand total, and no dry-run banner", () => {
    const out = formatMultiTenantReport({
      tenants: [
        {
          tenantId: TENANT,
          report: {
            relations: [{ left: "Product", right: "Tag", pruned: 2, kept: 5 }],
            totalPruned: 2,
            totalKept: 5,
          },
        },
      ],
      totalPruned: 2,
      totalKept: 5,
      dryRun: false,
    });
    expect(out).toContain(`tenant ${TENANT}`);
    expect(out).toContain("Product ↔ Tag: pruned 2, kept 5");
    expect(out).toContain("grand total: pruned 2, kept 5");
    expect(out).not.toContain("dry-run");
  });

  it("marks a dry run", () => {
    const out = formatMultiTenantReport({ tenants: [], totalPruned: 0, totalKept: 0, dryRun: true });
    expect(out).toContain("dry-run — nothing deleted");
    expect(out).toContain("no tenants to sweep");
  });
});
