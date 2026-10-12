import { describe, expect, it } from "vitest";

import {
  EXPECTED_PLATFORM_RECORD_TABLES,
  RECORD_RETENTION_FINDING_KINDS,
  auditRecordRetention,
  readCascadingTenantTables,
  readProtectedTables,
} from "./pg-record-retention.js";

describe("RECORD_RETENTION_FINDING_KINDS", () => {
  it("names the four ways the two halves of the rule can disagree", () => {
    expect(RECORD_RETENTION_FINDING_KINDS).toEqual([
      "protected_table_cascades",
      "protected_table_not_in_catalog",
      "protected_table_undeclared_here",
      "expected_protection_absent",
    ]);
  });
});

describe("reading the two halves from disk", () => {
  it("reads the erasure's protected set", () => {
    const tables = readProtectedTables();
    // A floor rather than an equality, so adding a protected table does not fail here — the
    // both-ways comparison in `auditRecordRetention` is what catches that.
    expect(tables.length).toBeGreaterThanOrEqual(16);
    expect(tables).toContain("tenant_tombstones");
    expect(tables).toContain("forensic_chain_entries");
    expect(new Set(tables).size).toBe(tables.length);
  });

  it("does not pick up a name from the two sets that sit beside it", () => {
    // `STATUTORY_RETENTION_TABLES` and `DELIBERATELY_ERASED_BILLING_TABLES` make the opposite
    // claim, and reading one of their names would invert the rule for that table.
    const tables = readProtectedTables();
    for (const erased of ["invoices", "tenant_credits", "billing_events", "subscriptions"]) {
      expect(tables, erased).not.toContain(erased);
    }
  });

  it("reads the catalog's cascading tenant tables", () => {
    const cascading = readCascadingTenantTables();
    // Vacuity floor: the overwhelming majority of tenant tables still cascade, and must. If this
    // collapsed toward zero the rule would pass having examined nothing.
    expect(cascading.length).toBeGreaterThan(80);
    expect(cascading).toContain("operate_entity_records");
    expect(new Set(cascading).size).toBe(cascading.length);
  });
});

describe("the platform's record outlives the tenant", () => {
  it("finds nothing", () => {
    const findings = auditRecordRetention();
    expect(
      findings.map((f) => `${f.kind}:${f.table}`),
      findings.map((f) => f.detail).join("\n"),
    ).toEqual([]);
  });

  it("protects exactly the sixteen this rule expects", () => {
    expect([...EXPECTED_PLATFORM_RECORD_TABLES].sort()).toEqual(
      [...readProtectedTables()].sort(),
    );
  });

  it("is not satisfied vacuously: the two sets really do overlap by name space", () => {
    // The rule only means something if a protected table *could* have been in the cascading set.
    // `audit_log` has a `tenant_id` and was cascading until ADR-0335, so the sets are drawn from one
    // population and an empty intersection is a fact rather than a type error.
    const protectedTables = readProtectedTables();
    const cascading = new Set(readCascadingTenantTables());
    expect(protectedTables).toContain("audit_log");
    expect(cascading.has("audit_log")).toBe(false);
    expect(cascading.size).toBeGreaterThan(protectedTables.length);
  });

  it("reports a cascade when one is present", () => {
    // The negative control. Re-adding `references: TENANT_FK` to `audit_log`'s `tenant_id` — which
    // is what the catalog said before ADR-0335 — must produce exactly one finding, naming it.
    const cascading = new Set([...readCascadingTenantTables(), "audit_log"]);
    const protectedTables = new Set(readProtectedTables());
    const offenders = [...protectedTables].filter((t) => cascading.has(t));
    expect(offenders).toEqual(["audit_log"]);
  });
});
