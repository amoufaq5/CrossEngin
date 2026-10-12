import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "./workspace-sql-scan.js";

/**
 * The rule: **no table the Article 17 erasure protects may carry a cascading `tenant_id` reference
 * to `meta.tenants`.**
 *
 * ADR-0335's finding. `eraseSharedTablesWithin` skips sixteen tables by name — the tombstone, the
 * deletion request, the forensic chain and its checkpoints, the audit log and its integrity
 * verdicts, the lifecycle events, the compliance attestations, the certification reports, the public
 * key registry and the six access-review tables — on the rule that they are *the platform's record
 * of what happened to the tenant*, not the tenant's data. Then ADR-0316's ordering retires the
 * `meta.tenants` row **after** the erasure commits, and `ON DELETE CASCADE` destroyed fifteen of
 * them anyway. Measured on two databases from one cluster, before and after the catalog fix:
 *
 * ```
 *   after retiring the tenant      pre-fix   post-fix
 *   forensic chain entries              0          1
 *   tombstones                          1          1
 *   anchor_exists                   false       true
 * ```
 *
 * So the proof outlived its witness, and `verifyStoredEvidence`'s `unwitnessed` defect — a paging
 * `sev1` under ADR-0324 — was true of every Article 17 proof the platform had ever produced, the
 * moment anything asked the chain rather than the column. `meta.tenant_tombstones` was the single
 * exception and is the precedent: ADR-0318 removed *its* reference for exactly this reason.
 *
 * **Why a strategy rule and not a comment.** The erasure's protected list lives in
 * `tenant-lifecycle-pg` and the cascade lives in the kernel's catalog, and neither package can
 * import the other (`tenant-lifecycle-pg` depends on the kernel). So the two halves of one rule sat
 * in files with no mechanical relationship, which is how they disagreed for eighteen ADRs. This
 * reads **both from disk as text**, exactly as `typecheck-config.ts` and `pg-column-coverage.ts` do
 * and for the same reason: importing `@crossengin/kernel` would make the dependency graph cyclic,
 * and reading `kernel/dist` would make the answer depend on whether someone ran `pnpm -r build`. A
 * rule that is green only after a build is not a rule.
 *
 * It also compares the two lists **in both directions**, because a table added to the erasure's
 * protected set with a cascade still on it is the same defect arriving from the other side — and a
 * both-ways comparison is the thing ADR-0288's `needsAuditEmitter` lacked.
 */
export const RECORD_RETENTION_FINDING_KINDS = [
  /** A protected table whose `tenant_id` references `meta.tenants`. The defect itself. */
  "protected_table_cascades",
  /** A name in the erasure's protected set that `META_TABLES` does not declare. */
  "protected_table_not_in_catalog",
  /** A catalogued table the erasure protects that this rule's own expectations omit. */
  "protected_table_undeclared_here",
  /** A name this rule expects to be protected that the erasure no longer protects. */
  "expected_protection_absent",
] as const;
export type RecordRetentionFindingKind = (typeof RECORD_RETENTION_FINDING_KINDS)[number];

export interface RecordRetentionFinding {
  readonly kind: RecordRetentionFindingKind;
  readonly table: string;
  readonly detail: string;
}

/**
 * The sixteen, spelled here as the third agreeing copy.
 *
 * Three copies sounds like the duplication this repo keeps removing, and the difference is that
 * these are **compared** rather than trusted: the erasure's set decides what is protected, the
 * catalog decides what cascades, and this list exists so that a change to *either* has to be
 * acknowledged in a diff. Dropping it and deriving from the erasure's set would make the rule
 * vacuous in the one case that matters — a table quietly removed from protection *and* given a
 * cascade would then satisfy it.
 */
export const EXPECTED_PLATFORM_RECORD_TABLES: readonly string[] = Object.freeze([
  "access_review_campaigns",
  "access_review_decisions",
  "access_review_evidence",
  "access_review_exceptions",
  "access_review_items",
  "access_review_templates",
  "audit_integrity_verdicts",
  "audit_log",
  "certification_reports",
  "compliance_attestations",
  "crypto_keys",
  "forensic_chain_entries",
  "forensic_chain_checkpoints",
  "gdpr_deletion_requests",
  "tenant_lifecycle_events",
  "tenant_tombstones",
]);

const CATALOG = join("packages", "kernel", "src", "bootstrap", "meta-schema.ts");
const ERASURE = join("packages", "tenant-lifecycle-pg", "src", "shared-table-erasure.ts");

/**
 * The table names `PLATFORM_RECORD_TABLES` holds, read out of its declaration.
 *
 * Bounded to that one array rather than scanning the file, because `STATUTORY_RETENTION_TABLES` and
 * `DELIBERATELY_ERASED_BILLING_TABLES` sit beside it and make opposite claims — picking up a name
 * from the wrong one would invert the rule.
 */
export function readProtectedTables(root: string = REPO_ROOT): readonly string[] {
  const src = readFileSync(join(root, ERASURE), "utf8");
  const start = src.indexOf("export const PLATFORM_RECORD_TABLES");
  if (start < 0) throw new Error(`PLATFORM_RECORD_TABLES not found in ${ERASURE}`);
  // Anchored on the freeze call, not on the first `[` after the name: the type annotation is
  // `readonly string[]`, so the first bracket belongs to it and the naive scan read an empty array
  // and reported every table as unprotected. A parse whose failure mode is "found nothing" is the
  // worst shape for a rule like this, which is why the test asserts a floor of sixteen names.
  const freeze = src.indexOf("Object.freeze(", start);
  if (freeze < 0) throw new Error(`PLATFORM_RECORD_TABLES is not an Object.freeze([...]) literal`);
  const open = src.indexOf("[", freeze);
  const close = src.indexOf("]", open);
  if (open < 0 || close < 0) throw new Error(`PLATFORM_RECORD_TABLES is not an array literal`);
  const body = src.slice(open, close);
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

/**
 * Every catalogued table whose `tenant_id` column references `meta.tenants`.
 *
 * Read as text from the one declaration shape the catalog uses — `references: TENANT_FK` on a
 * single-line column — and the parse **refuses rather than guessing** if that shape stops holding,
 * because a scan with a silent "could not read" bucket is the next member of this defect's class
 * (ADR-0334's rule for `pg-column-coverage.ts`).
 */
export function readCascadingTenantTables(root: string = REPO_ROOT): readonly string[] {
  const lines = readFileSync(join(root, CATALOG), "utf8").split("\n");
  const out: string[] = [];
  let current: string | null = null;
  let sawAnyTenantColumn = false;
  for (const line of lines) {
    const table = /^ {2}name: "([a-z_]+)",$/.exec(line);
    if (table !== null) {
      current = table[1]!;
      continue;
    }
    if (!line.includes('"tenant_id"')) continue;
    sawAnyTenantColumn = true;
    if (current === null) continue;
    if (line.includes("references: TENANT_FK")) out.push(current);
  }
  if (!sawAnyTenantColumn) {
    throw new Error(`no tenant_id column found in ${CATALOG}; the parse no longer matches the source`);
  }
  return out;
}

/** Both directions of the rule. An empty array is the only passing result. */
export function auditRecordRetention(
  root: string = REPO_ROOT,
): readonly RecordRetentionFinding[] {
  const protectedTables = new Set(readProtectedTables(root));
  const cascading = new Set(readCascadingTenantTables(root));
  const expected = new Set(EXPECTED_PLATFORM_RECORD_TABLES);
  const findings: RecordRetentionFinding[] = [];

  for (const table of [...protectedTables].sort()) {
    if (cascading.has(table)) {
      findings.push({
        kind: "protected_table_cascades",
        table,
        detail:
          `${table} is protected from the Article 17 erasure and its tenant_id still carries ` +
          `TENANT_FK (ON DELETE CASCADE), so retiring the meta.tenants row destroys the record ` +
          `the erasure deliberately kept`,
      });
    }
    if (!expected.has(table)) {
      findings.push({
        kind: "protected_table_undeclared_here",
        table,
        detail: `${table} is newly protected; add it to EXPECTED_PLATFORM_RECORD_TABLES`,
      });
    }
  }
  for (const table of [...expected].sort()) {
    if (!protectedTables.has(table)) {
      findings.push({
        kind: "expected_protection_absent",
        table,
        detail:
          `${table} is no longer in PLATFORM_RECORD_TABLES; if that is deliberate, remove it here ` +
          `too, and note that it then becomes erasable`,
      });
    }
  }
  return findings;
}
