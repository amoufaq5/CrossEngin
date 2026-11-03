import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EXPECTED_PLATFORM_RECORD_TABLES,
  RECORD_RETENTION_FINDING_KINDS,
  auditRecordRetention,
  readCascadingTenantTables,
  readProtectedTables,
  readDeleteFencedTables,
} from "./pg-record-retention.js";

describe("RECORD_RETENTION_FINDING_KINDS", () => {
  it("names the six ways the three halves of the rule can disagree", () => {
    expect(RECORD_RETENTION_FINDING_KINDS).toEqual([
      "protected_table_cascades",
      "protected_table_not_in_catalog",
      "protected_table_undeclared_here",
      "expected_protection_absent",
      "protected_table_unfenced",
      "fenced_table_not_protected",
    ]);
  });
});

describe("the DELETE fence half (ADR-0400)", () => {
  it("reads the fenced set from the catalog source", () => {
    const fenced = readDeleteFencedTables();
    // An equality rather than a floor, unlike the two reads below: this set is small, it is the
    // whole subject of the fence, and a seventeenth entry is the regression — a denial on a table
    // whose records do not outlive their tenant, which `fenced_table_not_protected` then reports
    // but which should also be visible here as a changed number.
    expect([...fenced].sort()).toEqual([...EXPECTED_PLATFORM_RECORD_TABLES].sort());
    expect(fenced).toHaveLength(16);
  });

  it("refuses rather than reporting nothing when the helper is renamed", () => {
    // The parse's failure mode decides whether this rule is worth anything: a scan that answers
    // "found no fences" for a renamed helper would report all sixteen tables unfenced, which reads
    // as the defect the rule exists to catch and would send the next reader to re-add sixteen
    // policies that are already there. ADR-0334's rule for `pg-column-coverage.ts`.
    const root = mkdtempSync(join(tmpdir(), "fence-parse-"));
    const dir = join(root, "packages", "kernel", "src", "bootstrap");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta-schema.ts"), 'const x = 1;\n  name: "tenant_id",\n');
    expect(() => readDeleteFencedTables(root)).toThrow(/retainedRecordNoTenantDelete/);
  });

  it("finds a protected table that lost its fence, in both directions", () => {
    // Driven against a fixture tree rather than the real one, so the assertion is about the rule
    // and not about today's catalog: the live tree answers zero findings, which cannot distinguish
    // a working rule from one that reports nothing.
    const root = mkdtempSync(join(tmpdir(), "fence-audit-"));
    const kdir = join(root, "packages", "kernel", "src", "bootstrap");
    const edir = join(root, "packages", "tenant-lifecycle-pg", "src");
    mkdirSync(kdir, { recursive: true });
    mkdirSync(edir, { recursive: true });
    writeFileSync(
      join(kdir, "meta-schema.ts"),
      "function retainedRecordNoTenantDelete(t: string) { return t; }\n" +
        '  name: "audit_log",\n' +
        '    { name: "tenant_id", type: "UUID" },\n' +
        '      retainedRecordNoTenantDelete("audit_log"),\n' +
        '      retainedRecordNoTenantDelete("job_runs"),\n',
    );
    writeFileSync(
      join(edir, "shared-table-erasure.ts"),
      "export const PLATFORM_RECORD_TABLES: readonly string[] = Object.freeze(\n" +
        '  ["audit_log", "tenant_tombstones"],\n);\n',
    );
    const kinds = auditRecordRetention(root).map((f) => `${f.kind}:${f.table}`);
    // `tenant_tombstones` is protected and unfenced; `job_runs` is fenced and unprotected.
    expect(kinds).toContain("protected_table_unfenced:tenant_tombstones");
    expect(kinds).toContain("fenced_table_not_protected:job_runs");
    // And `audit_log`, which is both protected and fenced, is reported by nothing — which is what
    // makes the two findings above about the fence rather than about the fixture being small.
    expect(kinds.filter((k) => k.endsWith(":audit_log"))).toEqual([]);
    // The fixture's erasure set omits the other fourteen, so the pre-existing arms fire too. Named
    // rather than counted, so this test fails if a new arm starts reporting the fixture as well.
    expect(new Set(kinds.map((k) => k.split(":")[0]))).toEqual(
      new Set([
        "expected_protection_absent",
        "protected_table_unfenced",
        "fenced_table_not_protected",
      ]),
    );
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
