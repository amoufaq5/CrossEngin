import { META_TABLES, type TableDefinition } from "@crossengin/kernel/bootstrap";
import { quoteIdent } from "@crossengin/kernel/ddl";
import type { PgConnection } from "@crossengin/kernel-pg";
import type { DeletionAttestation, RetentionObligation } from "@crossengin/tenant-lifecycle";

/**
 * Erasing a tenant's rows from the **shared** schema, which is the other half of what makes a tenant
 * deletion true.
 *
 * ADR-0316 erased a tenant's own Postgres schema; ADR-0317 refused a tombstone whose in-scope
 * subsystem had not attested; ADR-0328 took the scope out of the caller's hands. All three left
 * `shared_tables` — "rows in the shared boot schema and `meta.*`" — as a name in the vocabulary that
 * nothing erased. **113 of the then-144 `META_TABLES` carried a `tenant_id`**, so a GDPR Article 17
 * deletion dropped one schema and left the tenant's identity, audit, billing, workflow,
 * notification, lineage and entity-store rows exactly where they were — and a deployment that declared
 * `shared_tables: "erases"` handed in its own attestation and got that claim signed and anchored.
 *
 * Four rules shape this module.
 *
 * **The erasable set is derived from the catalog, never listed.** Every table carrying a `tenant_id`
 * is erasable unless it is named in `RETAINED_SHARED_TABLES`. A hand-maintained list of 96 names is
 * the defect that bit this repo three times (ADR-0288, ADR-0313, ADR-0328's `needsAuditEmitter`), and
 * each time the list and the thing it was supposed to mirror drifted. A table added tomorrow is
 * covered without anybody remembering, and the only edit a reviewer has to scrutinise is a
 * *retention*.
 *
 * **The catalog is not the whole of a tenant's data, and ADR-0350 is what that cost.** This
 * subsystem's declared remit has always been "rows in the shared boot schema and `meta.*`", and the
 * implementation reached `meta.*` alone: every `META_TABLES` entry declares `schema: "meta"`, so the
 * intersection with a boot manifest's own typed entity tables was empty. On `--store pg-columns`
 * those tables *are* the tenant's records, and `eraseTenantSchemaWithin` cannot reach them either —
 * it only ever drops the derived `t_<hex>` schema, which a boot-manifest tenant does not have, so
 * that subsystem took its `alreadyAbsent` path and attested `nothing_to_erase`. Nothing erased the
 * records, and the pipeline still composed a scope, hashed it, anchored it and stored a
 * self-verifying proof over them: reproduced live, with `public.patient` still holding the row the
 * proof said was gone. So the target list is the catalog's tenant-scoped tables **plus** a
 * `bootSchema.targets` list naming those entity tables, injected rather than derived here because the
 * function that creates them is the only thing entitled to name them (ADR-0284/0285) and this
 * package does not depend on it. The figures fold into one `shared_tables` claim, because
 * `duplicate_attestation` allows a subsystem exactly one.
 *
 * **The retention set is a constant, not configuration.** It is the one list that cannot be derived,
 * so every member is named and individually justified below. It is deliberately not a parameter: a
 * caller-supplied retention list is ADR-0328's defect in a new field — a remote client choosing how
 * much of the tenant's data its own "erasure" leaves behind.
 *
 * **There are two retention sets, because there are two different reasons.** ADR-0329 had only one,
 * defined as *not the tenant's data at all* — true of a forensic chain entry, and the only way a
 * single-outcome attestation could say `erased` without lying. The cost was that a genuine statutory
 * retention, a sales invoice under a seven-year tax obligation, was inexpressible: it is the tenant's
 * data, Article 17 reaches it, and the law forbids deleting it, so admitting it to a set whose
 * definition denies all three would have been a false statement inside a cryptographic proof. So
 * `PLATFORM_RECORD_TABLES` keeps the original rule and is silent in the proof, while
 * `STATUTORY_RETENTION_TABLES` carries an obligation per table and is **named** in the proof through
 * the `erased_and_retained` attestation. A table in both, or retained and in neither, is refused:
 * the two make opposite claims and a table may have only one.
 *
 * **Deletion order comes from the catalog's own invariant.** The meta-schema test suite enforces that
 * a foreign key resolves to a table declared *earlier* in `META_TABLES`, so deleting in **reverse**
 * catalog order always deletes a child before its parent. Nothing here hand-sorts: a `DELETE` that
 * trips a foreign key aborts the whole transaction, and the whole transaction is the deletion.
 *
 * **Measured, then confirmed absent.** Each table's figure is the `count(*)` of the rows its own
 * `DELETE` returned, so the number in the proof cannot disagree with the statement that produced it.
 * Afterwards every erasable table is re-counted and a survivor aborts the transaction, because a
 * deletion that reported success while rows remained is precisely the signed-proof-over-live-data
 * failure this module exists to end.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/** The column whose presence makes a table a tenant's to erase. */
export const TENANT_SCOPE_COLUMN = "tenant_id";

/**
 * The tables a deletion leaves because they are the **platform's record of what happened to the
 * tenant** — one line each, because this is a judgement rather than a derivation.
 *
 * The line that defines this set: an auditor or a regulator reads these *after* the tenant is gone,
 * and a deletion must not be able to destroy them. They are not the tenant's data and not an Article
 * 17 subject at all, which is what lets them sit outside the erasure without the attestation
 * claiming a retention. That is why `tenant_data_exports` — a copy of the subject's own data behind
 * a TTL'd link — is erased while `audit_log` is not.
 *
 * It is deliberately **not** the place for a lawful retention of the tenant's own records. ADR-0329
 * had to define this set as "not the tenant's data at all" so `shared_tables` could attest `erased`
 * without lying, and the cost was that a sales invoice under a tax obligation — genuinely the
 * tenant's data, genuinely undeletable — could only be expressed by joining a set whose definition
 * denies it. That is `STATUTORY_RETENTION_TABLES`, and the two are kept apart because they produce
 * different claims: this set is silent in the proof, that one is a named obligation inside it.
 */
export const PLATFORM_RECORD_TABLES: readonly string[] = Object.freeze(
  [
    // The proof itself: the row this very transaction inserts, plus any prior tombstone the new one
    // invalidates. Erasing it would destroy the Article 17 evidence in the commit that creates it.
    "tenant_tombstones",
    // The handle the deletion runs under. ADR-0322's premise is that a tombstone naming a request
    // exists iff that request's deletion committed — which needs the request to still be there.
    "gdpr_deletion_requests",
    // The append-only hash chain that witnesses the tombstone. The anchor is appended into this same
    // transaction, and removing entries is exactly the truncation ADR-0287 exists to detect.
    "forensic_chain_entries",
    // The only witness for *tail* truncation (ADR-0287): hash links cannot prove nothing was removed
    // from the end, so without checkpoints the retained chain proves less than it appears to.
    "forensic_chain_checkpoints",
    // The platform's record of what was done to this tenant, hash-chained and re-verified by every
    // integrity pass. The deletion's own `platform.*` rows land here while it runs.
    "audit_log",
    // The recorded verdicts over that chain. Erasing them deletes the evidence that the evidence was
    // ever verified, which is ADR-0323's defect class.
    "audit_integrity_verdicts",
    // The 7-state transition log, including the move to `deleted`. Without it nothing in the database
    // distinguishes a tenant that was deleted from one that never existed.
    "tenant_lifecycle_events",
    // Signed, hash-committed framework attestations by named attesters. A certification report
    // commits to them and a SOC 2 period audit reads them long after the tenant is gone.
    "compliance_attestations",
    // Sealed, hash-verified certification reports: the platform's own compliance posture for a past
    // period, evidenced partly by this tenant. Not the tenant's data to take with it.
    "certification_reports",
    // Holds **no private key material** — handles, fingerprints and *public* keys. `verify-chain`
    // resolves the public key from here to check the retained chain entries' Ed25519 signatures, so
    // erasing this leaves the evidence intact and unverifiable.
    "crypto_keys",
    // The six access-review tables are SOC 2 / ISO 27001 / HIPAA periodic attestation evidence, with
    // four-eyes decisions and sealed per-framework control mappings. An audit covering a past period
    // must still show the reviews that happened in it, and the six are one graph
    // (items → campaigns → templates; decisions and exceptions → items) that cannot be split.
    "access_review_templates",
    "access_review_campaigns",
    "access_review_items",
    "access_review_decisions",
    "access_review_exceptions",
    "access_review_evidence",
  ].sort(),
);

/** A table left in place because the law requires it, with the obligation that requires it. */
export interface StatutoryRetention {
  readonly table: string;
  readonly obligation: RetentionObligation;
}

/**
 * The tables a deletion leaves because they hold **the tenant's own data under a statutory
 * obligation**.
 *
 * Different in kind from `PLATFORM_RECORD_TABLES`, and that difference is the whole point: these
 * rows *are* the data subject's, Article 17 *does* reach them, and Article 17(3)(b) is why they
 * stay. So the proof says so — `shared_tables` attests `erased_and_retained`, names the obligation
 * and points at the tables — rather than going quiet about them the way a platform-record table is
 * quietly outside the erasure.
 *
 * Each entry has to carry its own obligation, and the rule for admitting one is narrow: **the
 * narrowest set of rows the obligation actually requires.** A seven-year tax retention is not a
 * licence to keep everything adjacent to an invoice, so the operational logs and the metered inputs
 * around these two are erased and the reasons are written down below.
 */
export const STATUTORY_RETENTION_TABLES: readonly StatutoryRetention[] = Object.freeze([
  // A tax invoice the platform *issued*. The issuer is obliged to keep it and its VAT/sales-tax
  // breakdown for the statutory period, which is longer than any erasure request; `number`,
  // `issued_at`, the `*_cents` columns and `line_items` are the record. Unambiguously the tenant's
  // data — it names them and what they were billed — which is exactly why it cannot go in the
  // platform-record set.
  Object.freeze({ table: "invoices", obligation: "tax_records_7y" as const }),
  // Credit notes against those invoices. Under most regimes a credit note is itself a tax document,
  // adjusting output tax — so retaining the invoices and destroying these would leave a *retained*
  // record that overstates the tax charged, which is a worse outcome than keeping neither.
  //
  // Hazard worth naming: `issued_by` references `meta.users` with `ON DELETE RESTRICT`, and
  // `meta.users` carries no `tenant_id`, so this erasure never touches it. The day a user erasure
  // becomes real, a retained row here makes the user who issued the credit undeletable — ADR-0318's
  // defect exactly. `retained_table_blocks_erasure` cannot see it, because it only reaches
  // tenant-scoped tables.
  Object.freeze({ table: "tenant_credits", obligation: "tax_records_7y" as const }),
]);

/**
 * Deliberately erased, with the reason, so nobody "completes the table" later (ADR-0329's rule for
 * the voice transients it named rather than omitted). Not read by anything — a comment would do —
 * except that a reader of the statutory set's two entries will immediately ask about these six:
 *
 *   - `billing_events` — the billing engine's operational log (`kind`, `actor`, and an unbounded
 *     `payload` holding whatever a provider sent). The accounting record is the invoice and the
 *     credit note; this adds provider payloads a seven-year retention must not sweep up.
 *   - `subscriptions` — the *current* state of a commercial contract, not a record of a past
 *     transaction, and the billed periods are on the invoices. There is also no member of
 *     `RETENTION_OBLIGATIONS` for a contractual limitation period, and `none` is not an obligation,
 *     so it is not expressible here even if it should be.
 *   - `billing_subscriptions` — a mutable entitlement snapshot that `EntitlementResolver` reads on
 *     the serving path. Retaining it would leave a deleted tenant *entitled*.
 *   - `billing_usage_records` — the metered inputs the invoice was rated from. The invoice's
 *     `line_items` carries the rated lines, so the retained record stands on its own.
 *   - `quota_usage`, `tenant_storage_usage` — operational metering.
 *   - `backfill_ledger` — migration bookkeeping.
 */
export const DELIBERATELY_ERASED_BILLING_TABLES: readonly string[] = Object.freeze([
  "backfill_ledger",
  "billing_events",
  "billing_subscriptions",
  "billing_usage_records",
  "quota_usage",
  "subscriptions",
  "tenant_storage_usage",
]);

/**
 * Every tenant-scoped table a deletion must not empty, for whichever of the two reasons.
 *
 * **Derived**, so the union has one source. A third hand-written list would be the drift this module
 * opens by refusing (ADR-0288, ADR-0313, ADR-0328) — and `retention_reason_unassigned` refuses on
 * the derivation anyway, for the day somebody replaces it with one.
 */
export const RETAINED_SHARED_TABLES: readonly string[] = Object.freeze(
  [...PLATFORM_RECORD_TABLES, ...STATUTORY_RETENTION_TABLES.map((r) => r.table)].sort(),
);

/** One table a deletion will empty, with the schema it lives in resolved. */
export interface SharedTableTarget {
  readonly schema: string;
  readonly table: string;
  /** `schema.table`, which is what `DeletionScope.tables` holds — a bare name would not say whose. */
  readonly qualified: string;
}

/**
 * One table the boot manifest's column store created, as this erasure wants it.
 *
 * A **structural** shape and not an imported type: `operate-runtime-pg` is what creates these
 * tables and so is the only thing entitled to name them, and this package does not depend on it and
 * must not start — the list travels the way `eraseTenantSchemaWithin` does, injected at the seam.
 */
export interface BootSchemaErasureTarget {
  readonly schema: string;
  readonly table: string;
}

/**
 * The catalog split into what a deletion empties and what it must leave, plus the two ways that split
 * can be wrong.
 *
 * Both failure fields are empty by construction — `erasable` is the complement of `retained` over the
 * tenant-scoped tables — and they are computed and refused on anyway. The construction *is* the
 * guarantee, and a later refactor that turned the complement into a second hand-written list would
 * break it without changing a single assertion that only looked at the two sets it was given.
 */
export interface SharedTablePartition {
  /** Every tenant-scoped table, in catalog order. */
  readonly tenantScoped: readonly SharedTableTarget[];
  /** To be emptied, in **deletion order**: reverse catalog order, so a child precedes its parent. */
  readonly erasable: readonly SharedTableTarget[];
  /** Left in place, for either reason. The union of the two below. */
  readonly retained: readonly SharedTableTarget[];
  /** Left because it is the platform's record of the deletion. Silent in the proof. */
  readonly platformRecord: readonly SharedTableTarget[];
  /** Left because the law requires it. A named obligation **in** the proof. */
  readonly statutory: readonly (SharedTableTarget & { readonly obligation: RetentionObligation })[];
  /** Tenant-scoped and in neither set. Empty by construction; see the interface note. */
  readonly unclassified: readonly string[];
  /**
   * Retained, but in neither reason set — so nothing says *why* it stays, and the two reasons make
   * different claims. Empty by construction while `retained` is their union.
   */
  readonly unassignedRetention: readonly string[];
  /**
   * Named by **both** reason sets. A table cannot be "not the tenant's data" and "the tenant's data
   * lawfully kept" at once, and which claim the attestation made would depend on iteration order —
   * which is the one-provenance rule ADR-0317 is built on.
   */
  readonly ambiguousRetention: readonly string[];
  /**
   * A retained table whose own foreign key would **block** an erasable table's `DELETE`.
   *
   * ADR-0318's defect, derived from the catalog instead of discovered by a deletion: a retained row
   * referencing an erasable parent with `ON DELETE RESTRICT`/`NO ACTION` makes the parent
   * undeletable *because* the retention exists, so every deletion for a tenant holding one aborts.
   * Vacuous for the current sets; computed because retaining a table is precisely the edit that
   * creates it.
   */
  readonly blockedByRetention: readonly string[];
  /**
   * Names in `RETAINED_SHARED_TABLES` that match no tenant-scoped table in the catalog.
   *
   * This is the direction that actually rots, and it rots silently in the severe direction: a
   * retention entry for a table that has since been renamed protects nothing, so the evidence it was
   * written to keep is erased with everything else.
   */
  readonly unresolvedRetention: readonly string[];
}

function targetOf(table: TableDefinition, schema: string | undefined): SharedTableTarget {
  const resolved = schema ?? table.schema;
  return { schema: resolved, table: table.name, qualified: `${resolved}.${table.name}` };
}

/**
 * Splits the catalog into the tables a deletion empties and the ones it leaves.
 *
 * `erasable` comes back in **reverse** catalog order. That is the whole ordering decision, and it
 * rests on an invariant the kernel's own test suite enforces: a foreign-key reference resolves to a
 * table declared *earlier* in `META_TABLES`. Reversing therefore guarantees every referencing table
 * is emptied before the table it references, without this module knowing one foreign key from
 * another.
 */
export function partitionSharedTables(
  catalog: readonly TableDefinition[] = META_TABLES,
  schema?: string,
): SharedTablePartition {
  const retainedNames = new Set(RETAINED_SHARED_TABLES);
  const platformRecordNames = new Set(PLATFORM_RECORD_TABLES);
  const obligations = new Map(STATUTORY_RETENTION_TABLES.map((r) => [r.table, r.obligation]));
  const tenantScoped: SharedTableTarget[] = [];
  const erasable: SharedTableTarget[] = [];
  const retained: SharedTableTarget[] = [];
  const platformRecord: SharedTableTarget[] = [];
  const statutory: (SharedTableTarget & { readonly obligation: RetentionObligation })[] = [];
  const unassignedRetention: string[] = [];
  const definitions = new Map<string, TableDefinition>();
  const seen = new Set<string>();

  for (const table of catalog) {
    if (!table.columns.some((c) => c.name === TENANT_SCOPE_COLUMN)) continue;
    const target = targetOf(table, schema);
    tenantScoped.push(target);
    seen.add(table.name);
    definitions.set(table.name, table);
    if (!retainedNames.has(table.name)) {
      erasable.push(target);
      continue;
    }
    retained.push(target);
    const obligation = obligations.get(table.name);
    if (platformRecordNames.has(table.name)) platformRecord.push(target);
    if (obligation !== undefined) statutory.push({ ...target, obligation });
    // A retention with no reason: neither set claims it, so the attestation would have no basis for
    // either claim. Unreachable while `retained` is the union of the two.
    if (obligation === undefined && !platformRecordNames.has(table.name)) {
      unassignedRetention.push(target.qualified);
    }
  }
  // Checked against the two arrays that were actually produced, not against the predicate that
  // produced them — so it still means something if the complement is ever replaced by a second list.
  const classified = new Set([...erasable, ...retained].map((t) => t.table));
  const unclassified = tenantScoped
    .filter((t) => !classified.has(t.table))
    .map((t) => t.qualified);

  const erasableNames = new Set(erasable.map((t) => t.table));
  const blockedByRetention: string[] = [];
  for (const target of retained) {
    for (const column of definitions.get(target.table)?.columns ?? []) {
      const ref = column.references;
      if (ref === undefined || !erasableNames.has(ref.table)) continue;
      // Absent `onDelete` is RESTRICT — the emitter's default, and `canonical.ts` treats it as such.
      const onDelete = ref.onDelete ?? "RESTRICT";
      // `SET DEFAULT` is flagged with the two that certainly block: it only succeeds if a parent row
      // matching the default exists, which this module cannot know, and a wrong guess here aborts
      // every deletion in the deployment.
      if (onDelete === "CASCADE" || onDelete === "SET NULL") continue;
      blockedByRetention.push(
        `${target.qualified}.${column.name} -> ${ref.table} (ON DELETE ${onDelete})`,
      );
    }
  }

  return {
    tenantScoped,
    // Reversed here rather than at the call site, so the ordering guarantee lives with the reasoning
    // for it.
    erasable: [...erasable].reverse(),
    retained,
    platformRecord,
    statutory,
    unclassified,
    unassignedRetention,
    ambiguousRetention: PLATFORM_RECORD_TABLES.filter((name) => obligations.has(name)),
    blockedByRetention,
    unresolvedRetention: RETAINED_SHARED_TABLES.filter((name) => !seen.has(name)),
  };
}

export const SHARED_TABLE_ERASURE_REFUSAL_REASONS = [
  /** `tenantId` is not a UUID, and every `tenant_id` column is one. */
  "invalid_tenant_id",
  /** `executedBy === approvedBy`. The same rule the record enforces, applied before the data is gone. */
  "four_eyes_violated",
  /**
   * A tenant-scoped table is in neither set. Unreachable while `erasable` is the complement of
   * `retained`; refused rather than assumed, because the day it is reachable a table is being skipped.
   */
  "unclassified_tenant_table",
  /** A retention entry resolves to no table in the catalog, so it protects nothing. */
  "retention_entry_unresolved",
  /**
   * A retained table in neither reason set, so nothing says why it stays.
   *
   * The same idiom as `unclassified_tenant_table` one level in: unreachable while `retained` is the
   * union of the two reason sets, and refused anyway, because the day it is reachable a table is
   * being kept for no stated reason and the attestation has no basis for either claim.
   */
  "retention_reason_unassigned",
  /**
   * A table in **both** reason sets. Not a redundancy: "not the tenant's data" and "the tenant's
   * data lawfully kept" are opposite claims, and the proof would carry whichever one the iteration
   * reached first. One table, one reason — ADR-0317's one-provenance rule.
   */
  "retention_reason_ambiguous",
  /**
   * A retained table's own foreign key would block an erasable table's `DELETE`.
   *
   * ADR-0318 found this with `meta.users`: a tombstone naming a user made that user undeletable
   * *because* the tombstone named them. Retaining a table is the edit that recreates it, so it is
   * derived from the catalog and refused before anything is destroyed rather than met as an aborted
   * transaction on a tenant who happened to hold the referencing row.
   */
  "retained_table_blocks_erasure",
  /**
   * A boot-schema target names a relation the target list already holds.
   *
   * `not_a_tenant_schema`'s counterpart, and the reason it exists is that this erasure's whole
   * predicate is `tenant_id = $1`: an entity called `AuditLog` served with `--schema meta` resolves
   * to `meta.audit_log`, which is tenant-scoped and **retained**, so the boot target would destroy
   * the platform's record of this very deletion with an entirely correct-looking statement. An
   * entity called `Tenants` or `Users` resolves to a catalogued table with no `tenant_id` at all,
   * where the `DELETE` raises mid-transaction instead — loud, and still worth converting into a
   * named refusal before anything is destroyed (ADR-0334's conversion).
   *
   * A relation named twice is the same refusal for the weaker reason: one `DELETE` issued twice,
   * and a coverage list that names one relation twice beside a proof it is read with.
   */
  "target_collides_with_catalog",
  /**
   * A boot-schema target's schema or table name is not a SQL identifier.
   *
   * These names come from the emitter that created the tables, so one that is not an identifier is a
   * programming error upstream rather than a deployment's typo — and it is a **refusal** and not a
   * throw for a reason that has nothing to do with whose fault it is. A throw raised inside the
   * pipeline's transaction that is not a `DeletionPipelineAborted` is, by ADR-0321's rule,
   * indistinguishable from an unknown failure: the runner files it `aborted` and leaves the request
   * `in_progress` for a human. A returned refusal is deterministic, so the request is `rejected` and
   * the operator is told what to fix. Nothing is destroyed either way; the difference is whether the
   * Article 17 request is stranded.
   */
  "boot_schema_target_invalid",
  /**
   * No order exists for the boot-schema targets, because their delete-blocking references form a
   * cycle.
   *
   * The targets arrive in the order their own foreign keys require, and the function that derives
   * them says when it could not: a cycle of `ON DELETE RESTRICT` references cannot be emptied by any
   * sequence of per-table statements, so the first refused `DELETE` would abort the pipeline's
   * transaction — `aborted`, stranded, with the tenant's schema already dropped inside the rollback.
   * Converted into a named refusal before anything is destroyed, naming the entities so the remedy
   * (declare `onDelete` on one relation in the cycle) is actionable. Vacuous across all seven
   * shipped packs, whose blocking subgraphs are acyclic.
   */
  "boot_schema_order_unrunnable",
  /** A target table — catalogued or boot-schema — the database does not have. */
  "table_missing",
  /**
   * A target table the database **does** have, and with no `tenant_id` column to scope by.
   *
   * Every statement this module issues carries `WHERE tenant_id = $1`, so such a table raises
   * `column "tenant_id" does not exist` — mid-transaction, after earlier targets have already been
   * emptied. The rollback means nothing is destroyed, and the cost is the same stranding
   * `boot_schema_target_invalid` describes. Reachable from both groups and for different reasons: a
   * boot target whose entity the column store never created this way, or a catalogued table the
   * database holds in a shape the catalog has since moved past — ADR-0300's drift, in the one
   * statement that must not be aimed by guesswork.
   */
  "target_lacks_tenant_scope",
  /**
   * The boot schema holds a table the column store plainly created and the target list does not
   * name.
   *
   * This is the original defect's own shape, one manifest later: a previous boot manifest's entity
   * table survives a manifest that no longer declares that entity, the current target list cannot
   * name it, and nothing would examine it — so the proof would attest `erased` over the tenant's
   * rows in it. The detector is a census of the boot schema in **both** directions
   * (`pg-record-retention.ts`'s rule: a one-way comparison is what made ADR-0288's list wrong three
   * times), narrowed to the signature this emitter writes and nothing else does — a policy named
   * `<relname>_tenant_isolation` — so an unrelated application's table sharing the schema is not
   * mistaken for one of ours.
   *
   * A refusal rather than a report, which is the opposite of how the undeclared-foreign-key case is
   * handled one package over, and for the one reason that outranks it: here the alternative to
   * refusing is signing a proof over live records, and that is exactly what ADR-0350 was opened to
   * stop. The remedy is a `DROP TABLE` the operator runs once, and the refusal names the tables.
   */
  "boot_schema_table_undeclared",
  /**
   * Row-level security is active for this session on a table it is about to empty.
   *
   * This is the refusal that earns the probe, and it was verified live rather than reasoned about. As
   * a non-owner role with no tenant context, the `DELETE` matched **0 rows**, reported 0, and the
   * confirm-absence `count(*)` *also* saw 0 — while the rows were still there. Both read through the
   * same policy, so the confirmation cannot catch it: the only place to catch it is before the first
   * statement. A table's owner bypasses RLS, so `row_security_active` is false exactly when the
   * session may really delete.
   */
  "rls_would_confine_this_session",
] as const;
export type SharedTableErasureRefusalReason =
  (typeof SHARED_TABLE_ERASURE_REFUSAL_REASONS)[number];

export interface SharedTableErasureRefusal {
  readonly reason: SharedTableErasureRefusalReason;
  readonly detail: string;
}

export interface SharedTableRowsErased {
  readonly table: string;
  /** The `count(*)` of the rows this table's own `DELETE` returned. */
  readonly rowCount: number;
  /** `sum(pg_column_size(row))` over those rows — see `storageBytes` on the erasure. */
  readonly storageBytes: number;
}

export interface SharedTableErasure {
  readonly tenantId: string;
  /**
   * The schema the **catalogued** half was aimed at. The boot-schema targets carry their own, which
   * is why every list below is schema-qualified rather than bare.
   */
  readonly schema: string;
  /** True only when rows were deleted **and** every erasable table was confirmed empty of them. */
  readonly erased: boolean;
  /**
   * True when no erasable shared table held a row for this tenant. Not an error; the end state is
   * the same. It says nothing about the statutory tables, which may still hold rows — see
   * `statutoryRetained`.
   */
  readonly nothingToErase: boolean;
  readonly refusals: readonly SharedTableErasureRefusal[];
  /** Only the tables that actually lost rows — see `sharedTableErasureScope`. */
  readonly erasedTables: readonly SharedTableRowsErased[];
  /**
   * Every table examined, schema-qualified, both groups, in deletion order. Coverage, which the
   * scope deliberately does not carry — and the one list in which a boot-schema target the
   * deployment holds but this tenant had no rows in is visible at all.
   */
  readonly examinedTables: readonly string[];
  /** Every table deliberately left, schema-qualified, so a reader can see the retention set applied. */
  readonly retainedTables: readonly string[];
  /** Of those, the ones left because they are the platform's record. Silent in the proof. */
  readonly platformRecordTables: readonly string[];
  /** Of those, the ones the law requires, whether or not this tenant had rows in them. Coverage. */
  readonly statutoryTables: readonly string[];
  /**
   * The statutory tables this tenant **actually still has rows in**, with the obligation keeping
   * each one. This is what the attestation's retained side is built from.
   *
   * Only the tables with surviving rows, for `erasedTables`' reason read the other way round: a
   * table with nothing in it was not retained, it was empty, and a proof claiming a retention over
   * an invoice the tenant never had is the same class of defect as a scope claiming a destruction
   * that did not happen. The row count behind the decision is **deliberately not carried** — the
   * figures in a proof describe what was destroyed, and a number beside a retained table would be
   * read as part of the erasure.
   */
  readonly statutoryRetained: readonly StatutoryRetention[];
  readonly rowCount: number;
  /**
   * The tuple bytes of the deleted rows, exclusive of index and TOAST overhead.
   *
   * A shared table's indexes and TOAST relation are shared with every other tenant, so there is no
   * per-tenant share of them to measure and apportioning one would be an estimate — which ADR-0316
   * refused for exactly this figure. Under-reporting what was measured is honest; it never claims
   * more was destroyed than was.
   */
  readonly storageBytes: number;
  readonly erasedAt: string;
}

export interface SharedTableErasureAuthority {
  readonly executedBy: string;
  /** Must differ from `executedBy` — see `four_eyes_violated`. */
  readonly approvedBy: string;
}

/**
 * The boot manifest's own entity tables, in the order they must be emptied, and the statement that
 * such an order exists.
 *
 * **One object rather than two parameters**, following `BuildOperateHttpServerOptions.abac`
 * (ADR-0342): the two come out of one derivation and most of the pairings that can be formed apart
 * are silently wrong. Targets without the cycle verdict is the dangerous one — the list looks
 * complete and the database refuses it partway through — and the verdict without the targets is
 * inert.
 *
 * The order inside `targets` is **not** reordered here. Its tables reference each other with
 * composite `ON DELETE RESTRICT` keys, so the group arrives in the order its own foreign keys
 * require, exactly as the catalogued half arrives in reverse `META_TABLES` order.
 */
export interface BootSchemaErasureInput {
  readonly targets: readonly BootSchemaErasureTarget[];
  /**
   * Entities whose delete-blocking references form a cycle — empty whenever an order exists. A
   * non-empty list is refused `boot_schema_order_unrunnable` before anything is destroyed.
   */
  readonly blockingCycle: readonly string[];
}

export interface SharedTableErasureOptions {
  /**
   * The boot manifest's own entity tables — **required, and an empty list is a legitimate value.**
   *
   * The requiredness is the whole fence, and it is deliberately chosen over the seventh
   * `DELETION_SUBSYSTEMS` member that would have declared the same thing. What that member would
   * have cost is in ADR-0350; what it would have bought is ADR-0329's v2 distinction — "we have no
   * entity tables" versus "we have them and nobody looked" — and a required parameter buys exactly
   * one half of that, more cheaply and at a different level. It makes *nobody looked*
   * **unrepresentable at compile time**, which a `.strict()` seventh key could only refuse at run
   * time; it does **not** put the distinction in the proof's signed bytes, where a seventh key
   * would have. An empty boot group and no boot group compose byte-identical scopes, so this
   * closes the mechanism's hole and leaves ADR-0329's. That gap is stated rather than papered over:
   * `[]` is what `--store pg` passes (its records being the catalogued
   * `meta.operate_entity_records`) and what `--store memory` passes, and a reader of the proof
   * cannot tell either from a `pg-columns` deployment whose list was derived from an empty
   * manifest.
   */
  readonly bootSchema: BootSchemaErasureInput;
  /**
   * Overrides the schema the **catalogued** tables are declared in — all of `META_TABLES` declares
   * `meta`. It does not reach `bootSchema.targets`, which carry their own: that is the whole point
   * of the second group, and a deployment serving entity tables from `meta` is refused rather than
   * merged (`target_collides_with_catalog`).
   */
  readonly schema?: string;
  /** Injected so a test can pin the catalog rather than assert against the live catalog's size. */
  readonly catalog?: readonly TableDefinition[];
  readonly clock?: () => Date;
}

/**
 * Which declared tables the database actually has, and which of them this session may really empty.
 *
 * One statement for both questions, because they have one answer: a table absent from `pg_class` is
 * missing, and a table present with `row_security_active` true is one whose `DELETE` would silently
 * match nothing. Read-only, so it is safe to run before anything is destroyed — which is the point.
 *
 * **The schema comes from each target, one statement per distinct schema.** Until ADR-0350 it was a
 * single parameter sitting beside targets that already carried one, which is the shape the
 * single-schema assumption lived in — and the boot manifest's entity tables are not in `meta`.
 * Grouping by schema keeps each statement's `nspname = $1` shape, rather than folding the two into
 * a pairwise join whose `(schema, table)` keying would be a second place to get the attribution
 * wrong: a bare name present in one schema must not mark the other schema's as present. A
 * deployment has two schemas here, not many.
 *
 * **And whether the column it scopes by exists**, which ADR-0329's version did not ask because every
 * catalogued target carried `tenant_id` by construction. A boot-schema target need not: every
 * statement below is `WHERE tenant_id = $1`, so a table without it raises mid-transaction, after
 * earlier targets have been emptied — the rollback saves the data and strands the request. One extra
 * column on a statement that already runs (the `relkind IN ('r','p')` filter is why `pg_attribute`
 * is read through `attrelid` rather than `information_schema`, which would not see a partition).
 */
export async function probeSharedTableErasability(
  tx: PgConnection,
  targets: readonly SharedTableTarget[],
): Promise<{
  readonly missing: readonly string[];
  readonly confined: readonly string[];
  readonly unscoped: readonly string[];
}> {
  const bySchema = new Map<string, string[]>();
  for (const target of targets) {
    const names = bySchema.get(target.schema);
    if (names === undefined) bySchema.set(target.schema, [target.table]);
    else names.push(target.table);
  }
  const missing: string[] = [];
  const confined: string[] = [];
  const unscoped: string[] = [];
  for (const [schema, names] of bySchema) {
    const result = await tx.query<{
      readonly table_name: unknown;
      readonly confined: unknown;
      readonly scoped: unknown;
    }>(
      `SELECT c.relname AS table_name, row_security_active(c.oid) AS confined,
              EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = '${TENANT_SCOPE_COLUMN}'
                         AND a.attnum > 0 AND NOT a.attisdropped) AS scoped
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname = ANY($2::text[])
      ORDER BY c.relname`,
      [schema, names],
    );
    const present = new Set<string>();
    for (const row of result.rows) {
      const name =
        row.table_name === null || row.table_name === undefined ? "" : String(row.table_name);
      if (name.length === 0) continue;
      present.add(name);
      if (row.confined === true || row.confined === "t" || row.confined === "true") {
        confined.push(`${schema}.${name}`);
      }
      // Absence is the finding, so anything that is not an affirmative yes reads as unscoped: a
      // probe that could not establish the column must not license a statement that needs it.
      if (!(row.scoped === true || row.scoped === "t" || row.scoped === "true")) {
        unscoped.push(`${schema}.${name}`);
      }
    }
    for (const name of names) {
      if (!present.has(name)) missing.push(`${schema}.${name}`);
    }
  }
  return { missing, confined, unscoped };
}

/**
 * Every table in the given schemas that this emitter plainly created, so the target list can be
 * compared against the database in **both** directions.
 *
 * The one-way comparison is what the original defect was made of, and
 * `packages/testing/src/strategy/pg-record-retention.ts` is the repo's statement of why: ADR-0288's
 * hand-maintained list was wrong three times and *location* was never the cause — the absence of a
 * both-ways comparison was. Here the missing direction is a table a **previous** boot manifest
 * created: the current manifest no longer declares that entity, so the derived target list cannot
 * name it, nothing examines it, and the proof attests `erased` over the tenant's rows in it.
 *
 * The signature is a policy named `<relname>_tenant_isolation`, which `emitEntityTableDdl` and
 * `emitJoinTableDdl` both write and which nothing else in this workspace writes into a
 * deployment-chosen schema. Narrow on purpose: the default boot schema is `public`, which a
 * deployment may share with tables that are none of our business, and a census keyed on "has a
 * `tenant_id` column" would refuse every Article 17 deletion in such a deployment. A table of ours
 * whose policy an operator dropped reads as not ours — under-reporting, which is the direction that
 * leaves the pre-ADR-0350 behaviour rather than inventing a new refusal.
 */
export async function censusBootSchemaTables(
  tx: PgConnection,
  schemas: readonly string[],
): Promise<readonly string[]> {
  if (schemas.length === 0) return [];
  const result = await tx.query<{ readonly qualified: unknown }>(
    `SELECT n.nspname || '.' || c.relname AS qualified
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_policy p ON p.polrelid = c.oid
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r', 'p')
        AND p.polname = c.relname || '_tenant_isolation'
      ORDER BY 1`,
    [[...schemas]],
  );
  const out: string[] = [];
  for (const row of result.rows) {
    const name = row.qualified === null || row.qualified === undefined ? "" : String(row.qualified);
    if (name.length > 0) out.push(name);
  }
  return out;
}

function toInt(value: unknown): number {
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(typeof value === "string" ? value : NaN);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/**
 * One table emptied of one tenant's rows, measured by the statement that emptied it.
 *
 * The `DELETE` is wrapped in a CTE so the count is of the rows it actually returned rather than of a
 * separate `SELECT` taken a moment earlier. ADR-0316's rule was `count(*)` over `reltuples` because a
 * proof commits to the figure; this is the same rule taken one step further — there is no window in
 * which the measurement and the deletion could disagree, because they are one statement.
 */
function deleteStatement(target: SharedTableTarget): string {
  const relation = `${quoteIdent(target.schema)}.${quoteIdent(target.table)}`;
  return (
    `WITH deleted AS (DELETE FROM ${relation} AS t WHERE t.${quoteIdent(TENANT_SCOPE_COLUMN)} = $1::uuid` +
    " RETURNING pg_column_size(t) AS bytes)" +
    " SELECT count(*) AS n, coalesce(sum(bytes), 0) AS bytes FROM deleted"
  );
}

function confirmStatement(target: SharedTableTarget): string {
  const relation = `${quoteIdent(target.schema)}.${quoteIdent(target.table)}`;
  return `SELECT count(*) AS n FROM ${relation} WHERE ${quoteIdent(TENANT_SCOPE_COLUMN)} = $1::uuid`;
}

/**
 * Empties one tenant's rows from every erasable catalogued table **and** from every boot-schema
 * target handed over, inside a transaction the caller owns.
 *
 * The two groups are **one** target list rather than two passes, which is the decision rather than a
 * convenience: it means every refusal is established for every target before the first `DELETE`, so
 * ADR-0330's "a returned refusal means nothing was destroyed" holds across both — see the probe.
 *
 * `-Within` only, following `eraseTenantSchemaWithin` (ADR-0319): the rows and the tombstone that
 * records their destruction commit together or not at all. It takes no advisory lock of its own
 * because the deletion pipeline already holds the per-tenant one as an *xact* lock, released by the
 * caller's commit.
 *
 * Refusals are settled in two passes and the order is deliberate. The cheap ones — a bad tenant id, a
 * missing second person, a catalog whose two sets do not partition — need no database at all and are
 * answered first, so a caller who may not erase never causes a probe against data they are not
 * entitled to touch. Only then does the probe run, and only then does anything get deleted.
 *
 * A refusal is **returned** with nothing deleted. A failed confirmation **throws**, because by then
 * rows are gone inside the caller's transaction and the only correct response is to abort it — the
 * same split `eraseTenantSchemaWithin` makes, and for the same reason.
 */
export async function eraseSharedTablesWithin(
  tx: PgConnection,
  tenantId: string,
  authority: SharedTableErasureAuthority,
  opts: SharedTableErasureOptions,
): Promise<SharedTableErasure> {
  const schema = opts.schema ?? "meta";
  if (!IDENT_RE.test(schema)) {
    // A programming error rather than a deployment condition, so it throws where the rest refuse —
    // matching `PostgresTombstoneStore`, which validates its schema in the constructor.
    throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  }
  // Identifiers are checked before anything is derived from them, and the ones that fail are kept
  // out of the target list rather than carried into it: a name that cannot be quoted cannot be
  // probed either, and `table_missing` for it would name the wrong defect.
  const bootTargets: SharedTableTarget[] = [];
  const invalidBootTargets: string[] = [];
  for (const t of opts.bootSchema.targets) {
    if (!IDENT_RE.test(t.schema) || !IDENT_RE.test(t.table)) {
      invalidBootTargets.push(`${t.schema}.${t.table}`);
      continue;
    }
    bootTargets.push({ schema: t.schema, table: t.table, qualified: `${t.schema}.${t.table}` });
  }
  const catalog = opts.catalog ?? META_TABLES;
  const partition = partitionSharedTables(catalog, schema);
  const at = (opts.clock ?? ((): Date => new Date()))().toISOString();
  // The tenant's own records first. The order *between* the two groups is free — the emitter writes
  // an entity table's `tenant_id` with no reference at all, and no catalogued table references an
  // entity table, so neither group's foreign keys reach the other — and they are first because they
  // are the tenant's own records, which is the figure an operator answering an Article 17 request
  // reads first. The order *within* each group is not free and neither is resorted here.
  const erasableTargets = [...bootTargets, ...partition.erasable];
  const examinedTables = erasableTargets.map((t) => t.qualified);
  const retainedTables = partition.retained.map((t) => t.qualified);
  const platformRecordTables = partition.platformRecord.map((t) => t.qualified);
  const statutoryTables = partition.statutory.map((t) => t.qualified);
  const refused = (refusals: readonly SharedTableErasureRefusal[]): SharedTableErasure => ({
    tenantId,
    schema,
    erased: false,
    nothingToErase: false,
    refusals,
    erasedTables: [],
    examinedTables,
    retainedTables,
    platformRecordTables,
    statutoryTables,
    // Empty on a refusal, and that is the honest reading rather than a gap: nothing was destroyed,
    // so nothing was *left behind by a deletion* either. A retention is a claim about an erasure
    // that happened.
    statutoryRetained: [],
    rowCount: 0,
    storageBytes: 0,
    erasedAt: at,
  });

  const cheap: SharedTableErasureRefusal[] = [];
  if (!UUID_RE.test(tenantId)) {
    cheap.push({
      reason: "invalid_tenant_id",
      detail: `tenantId must be a uuid, got ${JSON.stringify(tenantId)}`,
    });
  }
  if (authority.executedBy === authority.approvedBy) {
    cheap.push({
      reason: "four_eyes_violated",
      detail: "erasing a tenant's data requires a second person: executedBy must not be approvedBy",
    });
  }
  for (const name of partition.unclassified) {
    cheap.push({
      reason: "unclassified_tenant_table",
      detail:
        `${name} carries ${TENANT_SCOPE_COLUMN} and is in neither set; add it to` +
        " PLATFORM_RECORD_TABLES if it is the platform's record of the deletion, or to" +
        " STATUTORY_RETENTION_TABLES with its obligation if the law requires it, or leave it erasable",
    });
  }
  for (const name of partition.unassignedRetention) {
    cheap.push({
      reason: "retention_reason_unassigned",
      detail:
        `${name} is retained and in neither reason set; nothing says whether it stays because it is` +
        " the platform's record or because the law requires it, and the proof makes a different" +
        " claim in each case",
    });
  }
  for (const name of partition.ambiguousRetention) {
    cheap.push({
      reason: "retention_reason_ambiguous",
      detail:
        `'${name}' is in both PLATFORM_RECORD_TABLES and STATUTORY_RETENTION_TABLES; a table is` +
        " either not the tenant's data or the tenant's data lawfully kept, and those are opposite" +
        " claims — remove it from one",
    });
  }
  for (const detail of partition.blockedByRetention) {
    cheap.push({
      reason: "retained_table_blocks_erasure",
      detail:
        `${detail} is a retained row referencing a table this deletion empties; the parent's DELETE` +
        " would be refused and the whole transaction would abort — make it ON DELETE CASCADE/SET" +
        " NULL, drop the reference, or erase the retained table",
    });
  }
  for (const name of partition.unresolvedRetention) {
    cheap.push({
      reason: "retention_entry_unresolved",
      detail:
        `a retention set names '${name}', which is not a ${TENANT_SCOPE_COLUMN}-bearing table` +
        " in the catalog; a retention entry that matches nothing protects nothing",
    });
  }
  // Against the **whole** catalog and not only its tenant-scoped half: a collision with a
  // tenant-scoped table is the severe case (a correct-looking `tenant_id = $1` aimed at the
  // platform's rows, worst of all at a retained one), and a collision with a table carrying no
  // `tenant_id` raises mid-transaction instead — which rolls back, so nothing is destroyed either
  // way, and is still better said here than met as an aborted deletion.
  const cataloguedRelations = new Set(catalog.map((t) => `${schema}.${t.name}`));
  const claimed = new Set<string>();
  for (const target of bootTargets) {
    if (cataloguedRelations.has(target.qualified)) {
      cheap.push({
        reason: "target_collides_with_catalog",
        detail:
          `${target.qualified} is a boot-manifest entity table and a catalogued platform table at` +
          ` once; this erasure's only predicate is ${TENANT_SCOPE_COLUMN} = $1, so it would aim a` +
          " DELETE at the platform's own relation — and at the record of this very deletion if that" +
          " relation is one a retention set keeps. Serve the entity tables from a schema the" +
          " catalog does not use",
      });
      continue;
    }
    if (claimed.has(target.qualified)) {
      cheap.push({
        reason: "target_collides_with_catalog",
        detail:
          `${target.qualified} is named twice in the boot-schema target list; one relation would be` +
          " deleted twice and would be named twice in the coverage this proof is read beside",
      });
      continue;
    }
    claimed.add(target.qualified);
  }
  for (const name of invalidBootTargets) {
    cheap.push({
      reason: "boot_schema_target_invalid",
      detail:
        `the boot-schema target ${JSON.stringify(name)} is not a schema-qualified SQL identifier;` +
        " it was dropped from the target list rather than quoted, so this deletion would have been" +
        " silent about one of the tenant's own tables",
    });
  }
  if (opts.bootSchema.blockingCycle.length > 0) {
    cheap.push({
      reason: "boot_schema_order_unrunnable",
      // "blocked by" rather than "reference each other": the list is every entity a RESTRICT cycle
      // blocks, which includes the ones merely behind it, so the shorter sentence would be false of
      // some of the names it prints.
      detail:
        `${opts.bootSchema.blockingCycle.length.toString()} of the boot manifest's entities cannot` +
        " be emptied in any order because a cycle of ON DELETE RESTRICT references blocks them:" +
        ` ${opts.bootSchema.blockingCycle.join(", ")}. Whichever of their tables goes first, the` +
        " database refuses it and aborts this transaction. Declare onDelete cascade or set_null on" +
        " one relation in the cycle",
    });
  }
  if (cheap.length > 0) return refused(cheap);

  // **One probe over the merged list**, which is the property this whole design turns on: every
  // refusal is established for every target in both groups before the first DELETE runs, so
  // ADR-0330's "a returned refusal means nothing was destroyed" holds across both. Two erasures
  // would have needed the second's refusals known before the first wrote anything — a
  // survey-then-erase handshake across two packages, which is a worse version of what broke.
  //
  // The statutory tables are probed alongside the erasable ones even though nothing writes to them:
  // the census below *reads* them to decide whether a retention is claimed, and a confined session
  // would read 0 and report no retention while the rows were still there — `erased` instead of
  // `erased_and_retained`, which is a proof silent about data it did not destroy.
  const probe = await probeSharedTableErasability(tx, [
    ...erasableTargets,
    ...partition.statutory,
  ]);
  const probed: SharedTableErasureRefusal[] = [];
  if (probe.missing.length > 0) {
    probed.push({
      reason: "table_missing",
      // Both groups reach this message, so it may not attribute the absence to the catalog: a
      // missing `meta.*` table means the schema needs reconciling, while a missing boot-schema one
      // means the entity tables are not where this deletion was told to look, which is a different
      // single line of configuration.
      detail:
        `${probe.missing.length.toString()} target table(s) are declared and this database does not` +
        ` have them: ${probe.missing.join(", ")}; reconcile the catalogued schema, or point the` +
        " boot-schema targets at the schema the column store actually wrote to — neither is a table" +
        " to sign a proof over",
    });
  }
  if (probe.confined.length > 0) {
    probed.push({
      reason: "rls_would_confine_this_session",
      detail:
        `row-level security is active for this session on ${probe.confined.length.toString()} table(s):` +
        ` ${probe.confined.join(", ")}; the DELETE would match no rows and report none`,
    });
  }
  if (probe.unscoped.length > 0) {
    probed.push({
      reason: "target_lacks_tenant_scope",
      detail:
        `${probe.unscoped.length.toString()} target table(s) have no ${TENANT_SCOPE_COLUMN} column:` +
        ` ${probe.unscoped.join(", ")}; every statement here scopes by it, so the DELETE would raise` +
        " partway through and strand this request rather than deleting anything",
    });
  }
  // The other direction, which is the one the original defect was made of. Only over the schemas the
  // boot targets name: the catalogued half's schema is compared by `partitionSharedTables` against
  // `META_TABLES` already, and censusing `meta` here would report all 146 of them as undeclared.
  //
  // A deployment holding **no** boot targets names no schema and so is not censused, which is a
  // stated limit rather than an oversight: a deployment that served `--store pg-columns` and now
  // serves `--store pg` has those tables still on disk and passes `[]`, so this detector cannot see
  // them. Closing that needs the boot schema declared independently of the targets, which is a
  // deployment declaration and not something derivable from the manifest.
  const bootSchemas = [...new Set(bootTargets.map((t) => t.schema))];
  const undeclared = (await censusBootSchemaTables(tx, bootSchemas)).filter(
    (q) => !claimed.has(q),
  );
  if (undeclared.length > 0) {
    probed.push({
      reason: "boot_schema_table_undeclared",
      detail:
        `${undeclared.length.toString()} table(s) in ${bootSchemas.join(", ")} were created by the` +
        ` column store and this manifest does not declare them: ${undeclared.join(", ")}. A previous` +
        " manifest's entity table is the usual cause; nothing would examine it, and the proof would" +
        " attest that this tenant's rows are gone from the schema it still sits in. Drop it, or" +
        " serve a manifest that declares its entity",
    });
  }
  if (probed.length > 0) return refused(probed);

  const erasedTables: SharedTableRowsErased[] = [];
  let rowCount = 0;
  let storageBytes = 0;
  for (const target of erasableTargets) {
    const result = await tx.query<{ readonly n: unknown; readonly bytes: unknown }>(
      deleteStatement(target),
      [tenantId],
    );
    const rows = toInt(result.rows[0]?.n);
    if (rows === 0) continue;
    const bytes = toInt(result.rows[0]?.bytes);
    erasedTables.push({ table: target.qualified, rowCount: rows, storageBytes: bytes });
    rowCount += rows;
    storageBytes += bytes;
  }

  // Every erasable table in both groups, not only the ones that lost rows: the claim the proof makes
  // is that no row of this tenant remains in any shared table or any of the boot manifest's own, and
  // that is what has to be checked. One statement per table rather than one long UNION, for
  // `surveyTenantSchema`'s reason — each statement's shape stays fixed and auditable.
  const survivors: string[] = [];
  for (const target of erasableTargets) {
    const result = await tx.query<{ readonly n: unknown }>(confirmStatement(target), [tenantId]);
    const remaining = toInt(result.rows[0]?.n);
    if (remaining > 0) survivors.push(`${target.qualified} (${remaining.toString()} row(s))`);
  }
  if (survivors.length > 0) {
    throw new Error(
      `shared-table erasure for tenant ${tenantId} left rows behind in ${survivors.join(", ")};` +
        " rolling back rather than reporting them erased",
    );
  }

  // The mirror image of the confirm-absence pass, and the reason it cannot be the same check: a
  // statutory table's rows are *supposed* to remain, so confirming their absence would refuse every
  // deletion. What is confirmed instead is **presence**, and only to decide whether there is a
  // retention to claim at all — a proof asserting a seven-year hold over an invoice the tenant never
  // had is the same defect as a scope claiming a destruction that did not happen.
  //
  // Run after the deletes so it reports the state this transaction will commit, and the count is
  // read and thrown away: the retained side of an attestation has no numeric field, by design.
  const statutoryRetained: StatutoryRetention[] = [];
  for (const target of partition.statutory) {
    const result = await tx.query<{ readonly n: unknown }>(confirmStatement(target), [tenantId]);
    if (toInt(result.rows[0]?.n) > 0) {
      statutoryRetained.push({ table: target.qualified, obligation: target.obligation });
    }
  }

  return {
    tenantId,
    schema,
    erased: rowCount > 0,
    nothingToErase: rowCount === 0,
    refusals: [],
    erasedTables,
    examinedTables,
    retainedTables,
    platformRecordTables,
    statutoryTables,
    statutoryRetained,
    rowCount,
    storageBytes,
    erasedAt: at,
  };
}

/**
 * The `DeletionScope` fields `shared_tables` owns, shaped for an attestation.
 *
 * Exactly `tables`, `rowCount` and `storageBytes` — `SUBSYSTEM_SCOPE_FIELDS.shared_tables`, and
 * nothing else. Notably **not** `schemas`: the shared schema is not this tenant's and is not going
 * anywhere, and ADR-0317's rule is that a subsystem owns its fields exclusively so every list in a
 * scope has one provenance.
 *
 * `tables` lists only the tables that actually lost rows. A table emptied of nothing was examined,
 * not destroyed, and a scope that named it would claim a destruction that did not happen — coverage
 * is `examinedTables` on the erasure, deliberately beside the scope rather than in it.
 */
export function sharedTableErasureScope(erasure: SharedTableErasure): {
  readonly tables: readonly string[];
  readonly rowCount: number;
  readonly storageBytes: number;
} {
  if (!erasure.erased) return { tables: [], rowCount: 0, storageBytes: 0 };
  return {
    tables: erasure.erasedTables.map((t) => t.table),
    rowCount: erasure.rowCount,
    storageBytes: erasure.storageBytes,
  };
}

/**
 * The retained half of the claim: which obligations keep rows back, and where those rows are.
 *
 * `null` when there is nothing to claim, which is a different thing from an empty list — an empty
 * list on an `erased_and_retained` attestation is the silence ADR-0317 refuses, so the two must not
 * be able to collapse into each other. A caller gets either a complete retained side or none.
 *
 * Obligations are deduplicated and sorted so the claim does not depend on catalog order, and the
 * reference is the schema-qualified table names — a pointer, never a count.
 */
export function sharedTableRetention(erasure: SharedTableErasure): {
  readonly obligations: readonly RetentionObligation[];
  readonly dataReference: string;
} | null {
  if (erasure.statutoryRetained.length === 0) return null;
  const obligations = [...new Set(erasure.statutoryRetained.map((r) => r.obligation))].sort();
  return {
    obligations,
    dataReference: [...erasure.statutoryRetained.map((r) => r.table)].sort().join(", "),
  };
}

/**
 * The whole `shared_tables` claim as one attestation: what was destroyed, and what the law kept.
 *
 * Built here rather than in the pipeline so that the two retention sets, the census that reads them
 * and the claim they produce sit together — ADR-0317's one-provenance rule applied to the code as
 * well as to the scope. The pipeline still owns *when* it is called, which is the part that matters
 * for ADR-0319: an attestation about work the transaction has not done yet is a prediction.
 *
 * Four outcomes from two independent facts, and each one is the honest reading of its pair:
 *
 *   - destroyed something, kept something → `erased_and_retained`, the outcome this lane exists for
 *   - destroyed something, kept nothing   → `erased`, exactly as before
 *   - destroyed nothing, kept something   → `retained`; the tenant held only statutory rows
 *   - destroyed nothing, kept nothing     → `nothing_to_erase`
 *
 * The third case is why `retained` keeps its singular obligation and this function can still reach
 * it: with nothing destroyed there is no scope to carry, and `retained` is the contract's shape for
 * that. It takes exactly one obligation, so a census spanning two has nowhere to put the second —
 * and that is **refused here**, loudly, rather than narrowed. ADR-0330 recorded the expectation that
 * `DeletionAttestationSchema` would catch it; it cannot, and the distinction matters. The schema
 * checks the object it is handed, and an attestation built from `obligations[0]` is a perfectly valid
 * `retained` attestation — the second obligation is not rejected, it was never written down. So the
 * proof would name one lawful basis for data held under two, with every digest verifying over it.
 * Quietly dropping a reason from a proof is the defect this whole module exists to prevent, so the
 * one shape that could do it throws instead. Unreachable with the current set, where both entries
 * are `tax_records_7y`; reachable the day a second obligation joins, which is exactly when nobody
 * will be looking.
 */
export function sharedTableErasureAttestation(
  erasure: SharedTableErasure,
  attestedBy: string,
): DeletionAttestation {
  const retention = sharedTableRetention(erasure);
  const scope = sharedTableErasureScope(erasure);
  const base = { subsystem: "shared_tables" as const, attestedBy, attestedAt: erasure.erasedAt };
  if (!erasure.erased) {
    if (retention === null) return { ...base, outcome: "nothing_to_erase" };
    const only = retention.obligations[0];
    if (only === undefined || retention.obligations.length > 1) {
      throw new Error(
        "shared_tables erased nothing and is retaining data under more than one obligation" +
          ` (${retention.obligations.join(", ")}); the 'retained' outcome names exactly one, and` +
          " naming one of two would sign a proof that under-reports why the data is still there",
      );
    }
    return { ...base, outcome: "retained", retentionObligation: only, retainedDataReference: retention.dataReference };
  }
  // Exactly the three fields `SUBSYSTEM_SCOPE_FIELDS.shared_tables` names, and notably not
  // `schemas`: the shared schema is not this tenant's and is not going anywhere.
  const erased = { ...base, scope: { ...scope, tables: [...scope.tables] } };
  if (retention === null) return { ...erased, outcome: "erased" };
  return {
    ...erased,
    outcome: "erased_and_retained",
    retainedObligations: [...retention.obligations],
    retainedDataReference: retention.dataReference,
  };
}
