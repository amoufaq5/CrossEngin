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
 *
 * ## The four halves, and which set each is about
 *
 * The rule has grown three more questions and they do **not** share a predicate, which is the one
 * thing to get right before editing it. The original cascade arm is about `PLATFORM_RECORD_TABLES`
 * specifically — a platform record must not be a `CASCADE` child of the tenant row it outlives — and
 * the statutory tables are deliberately outside it, because a tenant's own retained data cascading
 * away with its tenant is a different question nobody has decided. The `DELETE` fence arms
 * (ADR-0400, widened in ADR-0401) are about the **union**, `RETAINED_SHARED_TABLES`, because both
 * halves forbid the same act for different reasons. And the fourth arm is about the fenced set's
 * closure under CASCADE-parenthood.
 *
 * That the fence arms compare against the union rather than against `PLATFORM_RECORD_TABLES` is
 * ADR-0401's correction and the reason it matters is worth keeping: for one increment this rule
 * asserted the narrower biconditional while CLAUDE.md's meta-schema invariant 5 claimed the wider
 * one, so the two statutory tables were exposed, the register said they could not be, and **the rule
 * would have refused the fix** — its right-to-left arm reporting `fenced_table_not_protected` for
 * exactly the two tables the invariant required to be fenced. A rule narrower than the invariant it
 * is cited for does not merely miss a defect; it enforces the negation of the claim.
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
  /**
   * A table the erasure retains that carries no restrictive `DELETE` policy, so the tenant whose
   * records it keeps can delete them itself. The retention set's own sentence is *"an auditor or a
   * regulator reads these after the tenant is gone, and a deletion must not be able to destroy
   * them"* — true of the platform's deletion and, until ADR-0400, unenforced against the tenant's.
   */
  "protected_table_unfenced",
  /**
   * A restrictive `DELETE` policy on a table the erasure does **not** retain. The other direction,
   * and the one a one-way comparison would miss: the fence's whole justification is that something
   * outside the tenant is entitled to read the table afterwards, so a fence somewhere else is a
   * denial with no argument behind it — and on a table with a legitimate tenant-context `DELETE`
   * writer it is a broken route, which `meta.operate_entity_records` makes concrete: fencing it
   * answers **404 for a record that exists** on the shipped `--store pg` delete route.
   */
  "fenced_table_not_protected",
  /**
   * A fenced table reachable by `ON DELETE CASCADE` from a parent that is **not** fenced (ADR-0401).
   *
   * RLS is not applied to referential actions, so a cascade deletes a fenced child's rows without
   * the child's restrictive policy ever being consulted. The fence's completeness is therefore a
   * property of the retained set being **closed under CASCADE-parenthood**, which nothing asserted:
   * measured at ADR-0401, all 3 CASCADE edges into a fenced child have a fenced parent
   * (`access_review_items → campaigns`, `decisions → items`, `exceptions → items`), so the set is
   * closed today and the fence is complete as shipped. A 19th retained table with an unfenced
   * cascading parent, or un-fencing a parent, would open it silently — and no other arm of this rule
   * can see it, because `readCascadingTenantTables` matches only lines carrying both `"tenant_id"`
   * and `references: TENANT_FK` and so is blind to a CASCADE on any other column.
   */
  "fenced_table_cascade_parent_unfenced",
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

/**
 * The statutory half, spelled here for the same reason — so that a change to *either* retention set
 * has to be acknowledged in a diff rather than silently widening or narrowing the fence's predicate.
 *
 * Two entries, both under one obligation, and the pair is load-bearing rather than incidental:
 * retaining `invoices` while `tenant_credits` goes leaves a retained record that **overstates** the
 * tax charged, which that set's own comment calls a worse outcome than keeping neither. So a diff
 * removing one of these two is the shape to look at hardest.
 */
export const EXPECTED_STATUTORY_RETENTION_TABLES: readonly string[] = Object.freeze([
  "invoices",
  "tenant_credits",
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

/**
 * The tables `STATUTORY_RETENTION_TABLES` holds — the erasure's *other* retention set, and the half
 * ADR-0400 left unfenced.
 *
 * Read separately from `PLATFORM_RECORD_TABLES` rather than parsing `RETAINED_SHARED_TABLES`, which
 * is the union both of them derive: that constant is
 * `[...PLATFORM_RECORD_TABLES, ...STATUTORY_RETENTION_TABLES.map((r) => r.table)].sort()`, a spread
 * over two identifiers with no table name of its own, so there is nothing in its text to read. The
 * union is reconstructed here from the two halves for the same reason the erasure reconstructs it
 * from them there.
 *
 * Its entries are `{ table, obligation }` objects rather than bare strings, which is the whole
 * difference between the two sets: a platform record is silent in the proof, while a statutorily
 * retained table is **named** in it with the obligation that keeps it (ADR-0330).
 */
export function readStatutoryRetentionTables(root: string = REPO_ROOT): readonly string[] {
  const src = readFileSync(join(root, ERASURE), "utf8");
  const start = src.indexOf("export const STATUTORY_RETENTION_TABLES");
  if (start < 0) throw new Error(`STATUTORY_RETENTION_TABLES not found in ${ERASURE}`);
  const freeze = src.indexOf("Object.freeze(", start);
  if (freeze < 0) {
    throw new Error(`STATUTORY_RETENTION_TABLES is not an Object.freeze([...]) literal`);
  }
  // Bracket-matched from the array's own `[` rather than scanning for a terminator string. The two
  // retention sets are written in *different* shapes — `Object.freeze(\n  [...].sort(),\n)` for the
  // platform half and `Object.freeze([\n ... \n])` for this one — so a search for `"\n);"` reads
  // past the end of this literal and stops at the next declaration's. That is how the first draft
  // of this reader passed against the real file while failing on a fixture: over-reading happened
  // to pick up the right entries plus some of a neighbour's, which is the parse whose failure mode
  // is "answers something plausible" rather than "refuses".
  const open = src.indexOf("[", freeze);
  if (open < 0) throw new Error(`STATUTORY_RETENTION_TABLES is not an array literal`);
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) throw new Error(`STATUTORY_RETENTION_TABLES literal is unterminated`);
  const body = src.slice(open, close);
  // `table: "x"` and never a bare `"x"`: the prose around these entries names other tables (the
  // `meta.users` hazard on `tenant_credits`, the billing tables erased beside them), so a quoted-name
  // scan would pick up a table this set does not retain and invert the rule for it.
  const tables = [...body.matchAll(/\btable:\s*"([a-z_]+)"/g)].map((m) => m[1]!);
  if (tables.length === 0) {
    throw new Error(
      `STATUTORY_RETENTION_TABLES parsed to zero tables in ${ERASURE}; the entry shape has ` +
        `changed, and "found nothing" would report both statutory tables as unretained`,
    );
  }
  return tables;
}

/**
 * The erasure's full retention set: the union the fence's predicate is, reconstructed from both
 * halves.
 *
 * This is the set CLAUDE.md's meta-schema invariant 5 claims the fence is equivalent to, and until
 * ADR-0401 the rule compared against `PLATFORM_RECORD_TABLES` alone — so the asserted biconditional
 * was strictly narrower than the claimed one, and in the one direction that mattered: it would have
 * reported `fenced_table_not_protected` for the two statutory tables, i.e. **forbidden the extension
 * the claimed invariant required**. A rule narrower than the invariant it is cited for is worse than
 * no rule, because it passes.
 */
export function readRetainedTables(root: string = REPO_ROOT): readonly string[] {
  return [...readProtectedTables(root), ...readStatutoryRetentionTables(root)].sort();
}

/**
 * Every `ON DELETE CASCADE` edge the catalog declares **inline**, as `{child, column, parent}`.
 *
 * Bounded to the inline form on a measurement rather than by omission: of 116 CASCADE edges in the
 * built catalog only 16 are written inline, because 99 come from the shared `TENANT_FK` constant and
 * 3 from `USER_OWNED_FK`. Those two point at `meta.tenants` and `meta.users`, **neither of which is
 * retained or fenced**, so no shared-constant edge can be an edge into a fenced child and the inline
 * parse is complete for the one question this asks. `cascadeConstantTargetsAreUnfenced` asserts that
 * premise rather than trusting it.
 */
export function readInlineCascadeEdges(
  root: string = REPO_ROOT,
): readonly { readonly child: string; readonly column: string; readonly parent: string }[] {
  const src = readFileSync(join(root, CATALOG), "utf8");
  const lines = src.split("\n");
  const out: { child: string; column: string; parent: string }[] = [];
  let table: string | null = null;
  let column: string | null = null;
  let refTable: string | null = null;
  let inRef = false;
  for (const line of lines) {
    const t = /^ {2}name: "([a-z_]+)",$/.exec(line);
    if (t !== null) {
      table = t[1]!;
      continue;
    }
    const c = /^\s+name: "([a-z_]+)",$/.exec(line);
    if (c !== null && !inRef) {
      column = c[1]!;
      continue;
    }
    if (/^\s+references:\s*\{\s*$/.test(line)) {
      inRef = true;
      refTable = null;
      continue;
    }
    if (!inRef) continue;
    const rt = /^\s+table:\s*"([a-z_]+)",$/.exec(line);
    if (rt !== null) {
      refTable = rt[1]!;
      continue;
    }
    if (/^\s+onDelete:\s*"CASCADE",$/.test(line) && table !== null && refTable !== null) {
      out.push({ child: table, column: column ?? "?", parent: refTable });
      continue;
    }
    if (/^\s+\},$/.test(line)) inRef = false;
  }
  if (out.length === 0) {
    throw new Error(
      `no inline ON DELETE CASCADE edge found in ${CATALOG}; the parse no longer matches the ` +
        `source, and "found nothing" would report the fenced set as trivially cascade-closed`,
    );
  }
  return out;
}

/**
 * Every catalogued table carrying a restrictive `DELETE` fence, read out of the one call shape the
 * catalog uses to declare one.
 *
 * Read as **text** for this module's own stated reason — importing `@crossengin/kernel` would make
 * the dependency graph cyclic and reading `kernel/dist` would make the rule green only after a
 * build. `tenantDeleteFencedTables()` is the same census derived from the built objects, and the two
 * are deliberately independent: the kernel's own test pins the derivation, and this one compares the
 * source against the erasure. A rule that imported the derivation would be comparing the catalog
 * with itself, which is the shape ADR-0353 found standing over `META_DEPLOYMENTS.target` while four
 * of its columns were drifted.
 *
 * The parse **refuses rather than guessing** if the call shape stops holding, because a scan with a
 * silent "could not read" bucket is the next member of this defect's class.
 */
export function readDeleteFencedTables(root: string = REPO_ROOT): readonly string[] {
  const src = readFileSync(join(root, CATALOG), "utf8");
  if (!src.includes("function retainedRecordNoTenantDelete")) {
    throw new Error(
      `retainedRecordNoTenantDelete is not declared in ${CATALOG}; the fence's helper has been ` +
        `renamed or removed, so this parse no longer finds the policies it reports on`,
    );
  }
  return [...src.matchAll(/retainedRecordNoTenantDelete\("([a-z_]+)"\)/g)].map((m) => m[1]!);
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
  const statutoryRead = new Set(readStatutoryRetentionTables(root));
  for (const table of EXPECTED_STATUTORY_RETENTION_TABLES) {
    if (!statutoryRead.has(table)) {
      findings.push({
        kind: "expected_protection_absent",
        table,
        detail:
          `${table} is no longer in STATUTORY_RETENTION_TABLES; if that is deliberate, remove it ` +
          `from EXPECTED_STATUTORY_RETENTION_TABLES too, and note that it then becomes erasable — ` +
          `and that dropping one of the two leaves the other overstating the tax charged`,
      });
    }
  }
  for (const table of [...statutoryRead].sort()) {
    if (!EXPECTED_STATUTORY_RETENTION_TABLES.includes(table)) {
      findings.push({
        kind: "protected_table_undeclared_here",
        table,
        detail:
          `${table} is newly retained under a statutory obligation; add it to ` +
          `EXPECTED_STATUTORY_RETENTION_TABLES`,
      });
    }
  }

  // The third half (ADR-0400), compared both ways for the same reason as the first two: the fence
  // set and the retention set are one judgement, so either changing without the other is a defect
  // whichever side it arrives from.
  //
  // Against the **union** of both retention sets since ADR-0401, not `PLATFORM_RECORD_TABLES` alone.
  // The narrower comparison passed while CLAUDE.md claimed the wider one, and its right-to-left arm
  // actively forbade fencing the two statutory tables — so the rule enforced the negation of the
  // invariant it was cited for.
  const retained = new Set(readRetainedTables(root));
  const fenced = new Set(readDeleteFencedTables(root));
  const statutory = new Set(readStatutoryRetentionTables(root));
  for (const table of [...retained].sort()) {
    if (!fenced.has(table)) {
      const why = statutory.has(table)
        ? `kept by the Article 17 erasure under a statutory obligation (Article 17(3)(b)), so the ` +
          `rows are the tenant's own and the law forbids destroying them`
        : `kept by the Article 17 erasure because it outlives its tenant`;
      findings.push({
        kind: "protected_table_unfenced",
        table,
        detail:
          `${table} is ${why}, and carries no restrictive DELETE policy — so a tenant-context ` +
          `session can delete its own rows from it, which the owner's count equalled when this ` +
          `was measured live; add retainedRecordNoTenantDelete("${table}") to its policies`,
      });
    }
  }
  for (const table of [...fenced].sort()) {
    if (!retained.has(table)) {
      findings.push({
        kind: "fenced_table_not_protected",
        table,
        detail:
          `${table} carries a restrictive DELETE policy and is in neither retention set, so the ` +
          `fence's argument — that something outside the tenant is entitled to read these rows ` +
          `afterwards — does not apply to it; if the table has a tenant-context DELETE writer ` +
          `the fence breaks that route, answering 404 for a record that exists`,
      });
    }
  }

  // The fourth half (ADR-0401): RLS is not applied to referential actions, so a CASCADE from an
  // unfenced parent deletes a fenced child's rows with the child's policy in place and never
  // consulted. Asserted rather than assumed — it holds today and nothing made it hold.
  for (const edge of readInlineCascadeEdges(root)) {
    if (!fenced.has(edge.child)) continue;
    if (fenced.has(edge.parent)) continue;
    findings.push({
      kind: "fenced_table_cascade_parent_unfenced",
      table: edge.child,
      detail:
        `${edge.child} carries a restrictive DELETE policy and is an ON DELETE CASCADE child of ` +
        `${edge.parent} via ${edge.child}.${edge.column}, which carries none — so deleting a ` +
        `${edge.parent} row destroys ${edge.child} rows without the fence being consulted, ` +
        `because RLS does not apply to referential actions; fence ${edge.parent} too, or the ` +
        `fence on ${edge.child} is reachable around`,
    });
  }
  return findings;
}

/**
 * The premise `readInlineCascadeEdges` rests on: the two shared `ColumnReference` constants point at
 * tables that are neither retained nor fenced, so no shared-constant CASCADE edge can reach a fenced
 * child and reading only the inline form loses nothing.
 *
 * Separate from `auditRecordRetention` because it is a statement about the *parse's* completeness
 * rather than about the catalog's correctness — and asserted at all because 100 of the 116 CASCADE
 * edges are invisible to a text parse, so "the inline form is enough" is exactly the kind of
 * convenient bound that would stop being true without anybody noticing.
 */
export function cascadeConstantTargetsAreUnfenced(root: string = REPO_ROOT): boolean {
  const retained = new Set(readRetainedTables(root));
  const fenced = new Set(readDeleteFencedTables(root));
  // `TENANT_FK` and `USER_OWNED_FK` are the catalog's only cascading shared references.
  return !["tenants", "users"].some((t) => retained.has(t) || fenced.has(t));
}
