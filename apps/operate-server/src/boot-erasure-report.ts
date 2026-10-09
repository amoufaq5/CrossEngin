/**
 * What this deployment will erase of a **tenant's own records**, said at boot.
 *
 * The defect in one sentence: a GDPR Article 17 deletion on `--store pg-columns` with a boot
 * manifest signed, anchored and stored a self-verifying tombstone and erased none of the tenant's
 * records. `eraseSharedTablesWithin` iterates `META_TABLES`, every entry of which declares
 * `schema: "meta"`, while `ColumnMappedEntityStore` writes to `<--schema ?? "public">`; the schema
 * erasure only ever drops the derived `t_<hex>` schema, which a boot-manifest tenant does not have,
 * so that subsystem took its `alreadyAbsent` path and attested `nothing_to_erase`. The intersection
 * of both target sets with the tenant's own tables was empty, and nothing anywhere said so.
 *
 * This module is the saying-so, and nothing else. It decides nothing about the erasure and issues
 * no SQL: `bootSchemaErasureTargets` names the targets, in the package whose store created those
 * tables, and `eraseSharedTablesWithin` empties them. All that is here is the figure, the schema it
 * is measured against, and the wording.
 *
 * **Said either way, including when the figure is zero.** "We checked and found none" cannot be
 * claimed from the absence of a log line, and the sharpest evidence is ADR-0316's own
 * live-verification notes, which record *"`meta` (144 tables) and `public` are untouched"* as a
 * **success** criterion. It was checked for *collateral* damage — the point of that bullet is that
 * `DROP SCHEMA t_<hex> CASCADE` reaches nothing outside the schema — and the same sentence reads as
 * coverage, so a passing check and a missing erasure were the same observation. A line that
 * appeared only when there was something to erase would have printed nothing on exactly the
 * deployment that was wrong.
 *
 * **Reported, never refused** — ADR-0322's rule, because this erasure degrades to *no record*
 * rather than to a wrong one. A manifest declaring no entity at all is odd and legitimate, and the
 * proof such a deployment signs attests over a scope that genuinely is empty. A boot refusal here
 * would refuse deployments that work; `bootErasureCoverageIsSuspect` is what earns the odd case a
 * `warn` instead.
 *
 * The figure is the **boot manifest's** tables and is deliberately not the whole truth: a tenant
 * serving its own activated manifest (ADR-0314) has its tables in `t_<hex>`, which is
 * `tenant_schema`'s subsystem and is covered there. That is a scope boundary rather than a gap, and
 * the lines below say so wherever the figure could be read as "all of a tenant's records".
 */

/**
 * The three fields as **one** type for both functions, so the pair cannot be called with inputs
 * that disagree: a caller formatting one deployment's coverage and testing another's would log a
 * line at `info` about a condition it had just measured as suspect.
 */
export interface BootErasureCoverageInput {
  readonly store: "memory" | "pg" | "pg-columns";
  /**
   * The schema the entity store writes to, **as the caller resolved it** — `--schema` with the
   * store's own default applied, which is `public` for the column store and `meta` for the JSONB
   * one. Resolved by the caller rather than defaulted here, because a second default in a third
   * place is the shape of the defect this increment closes.
   */
  readonly schema: string;
  /** `bootSchemaErasurePlan(...).targets.length`, which is zero on `pg` and `memory` by construction. */
  readonly targetCount: number;
  /**
   * `bootSchemaErasurePlan(...).blockingCycle` — entities whose `ON DELETE RESTRICT` references
   * form a cycle, so no order of per-table `DELETE`s can empty them.
   *
   * This is the one arm that is a *finding about a manifest* rather than about a store, and it is
   * reported here and refused in the erasure. The split is the usual one: a boot refusal would
   * break a deployment that serves such a manifest perfectly well, while an Article 17 deletion of
   * one cannot run at all, so the surface that destroys data refuses and the surface that serves it
   * says so.
   */
  readonly blockingCycle: readonly string[];
  /**
   * The `"<entity>.<field>"` references the deletion order gave up as `cascade` — empty for every
   * one of the seven shipped packs, whose only relaxations are `set_null`.
   *
   * It is reported because it is the one way the proof's **figure** can be wrong: a cascaded child
   * row is destroyed by its parent's statement, so the child's own `DELETE` counts fewer than it
   * removed. Deliberately not a refusal, and the distinction is what keeps this honest — the
   * confirm-absence pass still proves no row of the tenant's remains, so the *claim* stands and only
   * the volume understates it. A proof that overstates what it destroyed would be ADR-0337's
   * falsely-true control; one that understates it is a figure to say, not a claim to withdraw.
   */
  readonly relaxedCascades: readonly string[];
}

/** The label every arm leads with, so one grep finds this fact in any deployment's boot output. */
const LABEL = "tenant record erasure";

interface BootErasureAnswer {
  /** Greppable, and the only part a reader needs to tell the four answers apart. */
  readonly verdict: string;
  readonly detail: string;
}

/**
 * Whether the figure is a positive count of tables.
 *
 * `targetCount > 0` rather than a `<= 0` test at the call sites, because the two differ on `NaN`: a
 * caller handing this a count it could not compute must land on the branch that reports a finding,
 * never on the one that claims coverage. A count is a list's length, so anything that is not a
 * positive integer is a caller bug and the loud answer is the correct one.
 */
function hasTargets(targetCount: number): boolean {
  return targetCount > 0;
}

/**
 * The clause saying where a tenant's records live for this store, and what reaches them.
 *
 * A **total map** over the store kinds rather than a chain, so a fourth store is a compile error
 * instead of a store inheriting whichever branch the chain ended on — `PHI_VERDICT_MAY_SERVE`'s
 * shape, and the direction that matters here is that an unconsidered store must not report
 * coverage it does not have. Keyed off `BootErasureCoverageInput["store"]` so the union has one
 * spelling and the map cannot fall behind the field.
 *
 * ## Why every arm but one names the schema
 *
 * The figure alone does not say *where*. `bootSchemaErasureTargets` derives the count from the
 * **manifest**, so a misdirected `--schema` cannot make this figure zero — it makes every
 * `DELETE FROM <schema>.<table>` name a relation the database does not have, which `table_missing`
 * refuses. That refusal is loud and it arrives under an Article 12(3) deadline; the boot line is
 * where an operator can still see that the schema agrees with the one the column store wrote to,
 * months earlier.
 *
 * Two live ways for the two to disagree, and printing the schema is the cross-check for both.
 * `--schema` is one flag feeding two stores with **two different defaults** — `meta` for the JSONB
 * store and `public` for the column store, as `serve --help` states — so `--schema meta` on
 * `pg-columns` puts a tenant's entity tables in the catalog's own schema, where an entity named
 * `AuditLog` resolves to `meta.audit_log` and `target_collides_with_catalog` refuses a `tenant_id`
 * predicate that would otherwise have deleted the platform's own records with correct-looking SQL.
 * And the erasure's schema and the store's schema are resolved by separate defaults in separate
 * packages, which is precisely the shape of this defect: one side's default differing from the
 * other's, silently.
 *
 * `memory` is the one arm that names none, and says so rather than printing a default. Naming
 * `public` for a deployment with no database would invite an operator to believe something is being
 * erased from it, and this module's whole job is to stop a reassuring line standing in for an
 * erasure.
 */
const STORE_ANSWER: Readonly<
  Record<BootErasureCoverageInput["store"], (input: BootErasureCoverageInput) => BootErasureAnswer>
> = {
  memory: () => ({
    verdict: "no_database",
    detail:
      "--store memory holds a tenant's records in this process only, so there is nothing on disk " +
      "to erase and no schema to erase it from. The tenant deletion routes refuse to mount on this " +
      "store, so no Article 17 proof is issued from it either — the zero here is the absence of a " +
      "database and not an empty scope.",
  }),
  // Zero, as a fact rather than a finding: this store creates no typed entity tables at all, and
  // the two tables it does write are catalogued and tenant-scoped, so the erasure has reached them
  // since ADR-0329 without any of this increment's machinery. Both are named because a tenant's
  // links are records too — the parallel the `pg-columns` arm draws between entity and join tables.
  pg: ({ schema }) => ({
    verdict: "catalogued",
    detail:
      `--store pg holds a tenant's records as JSONB rows in ${schema}.operate_entity_records and ` +
      `their links in ${schema}.operate_entity_links, both declared in META_TABLES and both ` +
      `tenant-scoped, so the catalogued half of the shared-table erasure already deletes them by ` +
      `tenant_id. This store creates no typed entity tables, so a boot-schema target count of ` +
      `zero is a fact and not a finding.`,
  }),
  "pg-columns": (input) =>
    // The cycle is answered **before** the count, because a non-empty one makes the count a figure
    // about a list that cannot be run: reporting `column_tables: 54 table(s)` and refusing every
    // deletion would be the reassuring line this module exists to prevent.
    input.blockingCycle.length > 0
      ? {
          verdict: "order_unrunnable",
          // The list is `blockingCycle`, which is every entity a cycle of ON DELETE RESTRICT
          // references blocks — the cycle's members *and* whatever sits behind them. So the wording
          // is "blocked by" and not "reference each other": naming only the cycle would be the
          // shorter sentence and would be false of some of the names printed beside it.
          detail:
            `--store pg-columns holds a tenant's records in ${String(input.targetCount)} typed ` +
            `table(s) in schema ${input.schema}, and ${String(input.blockingCycle.length)} of this ` +
            `manifest's entities cannot be emptied in any order because a cycle of ON DELETE ` +
            `RESTRICT references blocks them: ${input.blockingCycle.join(", ")}. So an Article 17 ` +
            `deletion will be refused boot_schema_order_unrunnable before anything is destroyed. ` +
            `Serving is unaffected; declare onDelete cascade or set_null on one relation in the ` +
            `cycle to make the deletion runnable.`,
        }
      : hasTargets(input.targetCount)
      ? {
          verdict: "column_tables",
          detail:
            `--store pg-columns holds a tenant's records in ` +
            `${String(input.targetCount)} typed table(s) in schema ${input.schema} — entity tables ` +
            `and m2m join tables, none of them in META_TABLES — and the shared-table erasure now ` +
            `empties each by tenant_id, counts the rows with count(*) and confirms their absence ` +
            `before the tombstone commits to the figure. None of them is retainable: a statutory ` +
            `obligation over a tenant's own records is not expressible, because both retention sets ` +
            `are constants over META_TABLES. A tenant serving its own activated manifest has its ` +
            `tables in t_<hex> instead, which tenant_schema's erasure covers and this figure does ` +
            `not.` +
            (input.relaxedCascades.length > 0
              ? ` ${String(input.relaxedCascades.length)} reference(s) are emptied parent-first to ` +
                `break a cycle (${input.relaxedCascades.join(", ")}), each ON DELETE CASCADE, so ` +
                `the tombstone's row count understates those children by however many it cascaded.`
              : ""),
        }
      : {
          // The one odd pair, and the reason it is reported rather than refused: it is also the
          // expected answer for a deployment that serves only per-tenant activated manifests, whose
          // boot pack may legitimately declare nothing. So the remedy named is not a schema — a
          // wrong schema cannot produce this — but *which manifest loaded*, because the wrong pack
          // and an entity-less one read identically from here.
          verdict: "no_targets",
          detail:
            `--store pg-columns writes a tenant's records to typed tables in schema ` +
            `${input.schema} and this manifest declares none, so an Article 17 deletion will sign ` +
            `a proof whose scope names no table of the tenant's own. That is correct for a ` +
            `manifest with no entities, and expected where every tenant serves its own activated ` +
            `manifest from t_<hex>; check that the manifest this server loaded is the one ` +
            `intended, because the wrong pack reads identically here.`,
        },
};

/**
 * The boot line. Carries the verdict first, because that is what an operator greps for, and is one
 * line: a boot fact per line is what makes the absence of this one visible in a diff of two boots.
 */
export function formatBootErasureCoverage(input: BootErasureCoverageInput): string {
  const answer = STORE_ANSWER[input.store](input);
  return `${LABEL}: ${answer.verdict} — ${answer.detail}`;
}

/**
 * True when this deployment's answer deserves a `warn` rather than an `info`: `pg-columns` with no
 * targets at all, or with an order the erasure will refuse.
 *
 * Shares `hasTargets` and the same cycle test with the `pg-columns` arm above rather than restating
 * either, so the verdict an operator reads and the level it is logged at cannot disagree about one
 * deployment.
 *
 * A relaxed `cascade` is deliberately **not** suspect. It is a caveat on a figure inside a line
 * that already carries it, and warning on it would train an operator to ignore the level on exactly
 * the two conditions that are findings.
 *
 * `pg` and `memory` are never suspect whatever the count, because for them zero is the correct
 * answer and a non-zero one is the caller's business: this function reports a condition, so it must
 * not become a second place that decides what a store's target list should have been.
 */
export function bootErasureCoverageIsSuspect(input: BootErasureCoverageInput): boolean {
  if (input.store !== "pg-columns") return false;
  return input.blockingCycle.length > 0 || !hasTargets(input.targetCount);
}
