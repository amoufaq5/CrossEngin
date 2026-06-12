import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Manifest } from "@crossengin/kernel/manifest";
import { InMemoryEntityStore } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import { loadBuiltinPack } from "./manifest-source.js";
import { buildPrincipalWiring, parseApiKeySpec } from "./principals.js";
import { buildManifestReportRunner } from "./reports.js";
import { composeTenantManifest } from "./tenant-compile.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const baseManifest = await loadBuiltinPack("erp-retail");
const educationPack = await loadBuiltinPack("erp-education");

// Add a synthetic report referencing the commercial_sensitive Product.unit_cost,
// so a cashier (no unit_cost read grant) is fail-closed.
const manifest = {
  ...baseManifest,
  reports: {
    ...(baseManifest as unknown as { reports?: Record<string, unknown> }).reports,
    costSum: { kind: "kpi", entity: "Product", measure: { name: "cost", kind: "sum", field: "unit_cost" } },
  },
} as unknown as Manifest;

const principalRoles = buildPrincipalWiring([
  parseApiKeySpec(`k-c:cashier:${TENANT}`),
  parseApiKeySpec(`k-m:store_manager:${TENANT}`),
]).principalRoles;

function principal(role: string): ResolvedPrincipal {
  return { tenantId: TENANT, grantedScopes: [role] } as unknown as ResolvedPrincipal;
}

async function seed(store: InMemoryEntityStore): Promise<void> {
  for (const p of [
    { sku: "G1", name: "A", category: "grocery", status: "active", unit_price: 10, unit_cost: 4 },
    { sku: "G2", name: "B", category: "grocery", status: "active", unit_price: 20, unit_cost: 5 },
    { sku: "H1", name: "C", category: "home", status: "discontinued", unit_price: 30, unit_cost: 9 },
  ]) {
    await store.create(TENANT, "Product", p);
  }
  for (const o of [
    { order_number: "O1", state: "placed", currency: "AED", total: 100 },
    { order_number: "O2", state: "placed", currency: "AED", total: 50 },
    { order_number: "O3", state: "cart", currency: "AED", total: 25 },
  ]) {
    await store.create(TENANT, "SalesOrder", o);
  }
}

function runnerOver(store: InMemoryEntityStore) {
  return buildManifestReportRunner({ manifest, store, principalRoles });
}

describe("buildManifestReportRunner (in-memory path)", () => {
  it("computes a kpi report over the entity's records", async () => {
    const store = new InMemoryEntityStore();
    await seed(store);
    const out = await runnerOver(store).run("salesRevenue", { tenantId: TENANT, principal: principal("store_manager"), query: {} });
    expect(out).toMatchObject({ kind: "kpi", name: "total_revenue", value: 175 });
  });

  it("computes a tabular group-by report", async () => {
    const store = new InMemoryEntityStore();
    await seed(store);
    const out = (await runnerOver(store).run("ordersByState", {
      tenantId: TENANT,
      principal: principal("store_manager"),
      query: {},
    })) as { kind: string; rows: Array<Record<string, unknown>> };
    expect(out.kind).toBe("tabular");
    const placed = out.rows.find((r) => r["state"] === "placed");
    expect(placed).toMatchObject({ orders: 2, revenue: 150 });
  });

  it("computes a pivot report (category × status)", async () => {
    const store = new InMemoryEntityStore();
    await seed(store);
    const out = (await runnerOver(store).run("productByCategoryStatus", {
      tenantId: TENANT,
      principal: principal("store_manager"),
      query: {},
    })) as { kind: string; cells: Array<{ rowKey: string[]; colKey: string[]; values: Record<string, number> }> };
    expect(out.kind).toBe("pivot");
    const groceryActive = out.cells.find((c) => c.rowKey[0] === "grocery" && c.colKey[0] === "active");
    expect(groceryActive?.values["products"]).toBe(2);
  });

  it("returns null for an unknown report (fail-closed)", async () => {
    const store = new InMemoryEntityStore();
    expect(await runnerOver(store).run("ghost", { tenantId: TENANT, principal: principal("store_manager"), query: {} })).toBeNull();
  });

  it("withholds a report referencing a field the caller can't read (cashier vs manager)", async () => {
    const store = new InMemoryEntityStore();
    await seed(store);
    // cashier has no unit_cost read grant → fail-closed null
    expect(await runnerOver(store).run("costSum", { tenantId: TENANT, principal: principal("cashier"), query: {} })).toBeNull();
    // manager can read unit_cost → real aggregate
    const mgr = await runnerOver(store).run("costSum", { tenantId: TENANT, principal: principal("store_manager"), query: {} });
    expect(mgr).toMatchObject({ kind: "kpi", name: "cost", value: 18 });
  });
});

// P5.8: the per-tenant report runner over the *composed* (base + installed pack)
// manifest resolves an installed pack's report — the base manifest's runner doesn't.
describe("buildManifestReportRunner over a composed (base + installed pack) manifest", () => {
  const composed = composeTenantManifest(baseManifest, [educationPack]);
  const eduRoles = buildPrincipalWiring([parseApiKeySpec(`k-e:education_admin:${TENANT}`)]).principalRoles;

  async function seedCourses(store: InMemoryEntityStore): Promise<void> {
    for (const c of [
      { account_id: TENANT, code: "CS101", title: "Intro", department: "cs", credits: 3, capacity: 40, state: "open" },
      { account_id: TENANT, code: "CS201", title: "Data", department: "cs", credits: 4, capacity: 60, state: "open" },
    ]) {
      await store.create(TENANT, "Course", c);
    }
  }

  it("resolves the installed pack's report (education courseCapacity → 100)", async () => {
    const store = new InMemoryEntityStore();
    await seedCourses(store);
    const runner = buildManifestReportRunner({ manifest: composed, store, principalRoles: eduRoles });
    const out = await runner.run("courseCapacity", {
      tenantId: TENANT,
      principal: principal("education_admin"),
      query: {},
    });
    expect(out).toMatchObject({ kind: "kpi", name: "total_capacity", value: 100 });
  });

  it("the base manifest's runner returns null for the installed pack's report (fail-closed)", async () => {
    const store = new InMemoryEntityStore();
    const base = buildManifestReportRunner({ manifest: baseManifest, store, principalRoles: eduRoles });
    expect(await base.run("courseCapacity", { tenantId: TENANT, principal: principal("education_admin"), query: {} })).toBeNull();
  });
});
