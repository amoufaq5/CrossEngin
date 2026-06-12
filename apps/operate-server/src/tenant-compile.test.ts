import { tryValidateManifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import { loadBuiltinPack } from "./manifest-source.js";
import { composeTenantManifest, tenantRouteSummaries } from "./tenant-compile.js";

const retail = await loadBuiltinPack("erp-retail");
const education = await loadBuiltinPack("erp-education");
const construction = await loadBuiltinPack("erp-construction");

describe("composeTenantManifest", () => {
  it("merges base + installed pack entities, deduping shared core (4 core + 4 retail + 4 edu)", () => {
    const composed = composeTenantManifest(retail, [education]);
    const names = (composed.entities ?? []).map((e) => e.name);
    expect(names).toEqual([
      "Account",
      "Contact",
      "Invoice",
      "InvoiceLine",
      "Product",
      "Store",
      "SalesOrder",
      "OrderLine",
      "Course",
      "Student",
      "Enrollment",
      "Assignment",
    ]);
    // Account (core) appears exactly once despite being in both lineages.
    expect(names.filter((n) => n === "Account")).toHaveLength(1);
  });

  it("cross-validates the composed manifest (distinct verticals over shared core)", () => {
    const composed = composeTenantManifest(retail, [education, construction]);
    const result = tryValidateManifest(composed);
    if (!result.ok) throw new Error(`composed manifest invalid: ${JSON.stringify(result.errors)}`);
    expect(result.ok).toBe(true);
    // 4 core + 4 retail + 4 edu + 4 construction = 16
    expect((composed.entities ?? []).length).toBe(16);
  });

  it("merges roles + workflows from every pack (deduping the core invoice_lifecycle)", () => {
    const composed = composeTenantManifest(retail, [education]);
    expect(Object.keys(composed.roles ?? {})).toEqual(
      expect.arrayContaining(["store_manager", "registrar", "instructor"]),
    );
    expect(Object.keys(composed.workflows ?? {}).sort()).toEqual([
      "course_lifecycle",
      "enrollment_lifecycle",
      "invoice_lifecycle",
      "sales_order_lifecycle",
    ]);
  });

  it("keeps the base meta identity", () => {
    expect(composeTenantManifest(retail, [education]).meta.slug).toBe(retail.meta.slug);
  });
});

describe("tenantRouteSummaries", () => {
  it("derives the installed pack's REST routes (CRUD + lifecycle) from the composed manifest", () => {
    const routes = tenantRouteSummaries(retail, [education]);
    const course = routes.filter((r) => r.entity === "Course").map((r) => `${r.method} ${r.path}`);
    expect(course).toEqual(
      expect.arrayContaining([
        "GET /v1/courses",
        "POST /v1/courses",
        "GET /v1/courses/{id}",
        "POST /v1/courses/{id}/publish",
      ]),
    );
    // the base retail routes are still present too
    expect(routes.some((r) => r.path === "/v1/products")).toBe(true);
  });

  it("an empty install set yields just the base routes", () => {
    const base = tenantRouteSummaries(retail, []);
    expect(base.some((r) => r.entity === "Course")).toBe(false);
    expect(base.some((r) => r.entity === "Product")).toBe(true);
  });
});
