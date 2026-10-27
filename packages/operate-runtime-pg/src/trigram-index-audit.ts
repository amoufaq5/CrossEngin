import type { PgConnection } from "@crossengin/kernel-pg";

import { SUPERSEDED_TRIGRAM_SUFFIX } from "./entity-ddl.js";

/**
 * Finds the bare-column trigram indexes an earlier manifest left behind, and hands over the
 * `DROP INDEX` statements without running one.
 *
 * Why this exists at all: the trigram index moved from `gin (<col> gin_trgm_ops)` to
 * `gin (ce_unaccent(<col>::text) gin_trgm_ops)` under a **new name**, because `CREATE INDEX IF NOT
 * EXISTS` would otherwise find the old index, no-op, and leave the fix landing on fresh databases
 * only. An additive migration never drops anything, so an already-applied deployment carries both:
 * one that serves the predicate and one that serves nothing. The superseded set is not cheap,
 * measured on PG 16.13: five trigram indexes over a 1,000,000-row table carrying the emitter's own
 * shape hold **195 MB** against a 141 MB heap, and five over a fresh table cost **13.6x** on write
 * throughput -- 10,000 inserts in 582.9 ms with them against 42.9 ms without.
 *
 * Reported and never dropped, which is ADR-0330's idiom for a statement a plan must not run
 * unasked: `DROP INDEX` is irreversible without a rebuild, and the rebuild of a 128 MB index on a
 * live table is an outage an operator schedules rather than discovers.
 *
 * ## Scope, and why it is deliberately narrow
 *
 * Three conjuncts, and the first two are the finding while the third is the fence:
 *
 * - the access method is `gin` and the first operator class is `gin_trgm_ops` -- asked of
 *   `pg_opclass` through `pg_index.indclass`, not read out of `pg_get_indexdef`'s text, because
 *   this repo's rule is to ask Postgres for a fact it will state (ADR-0330);
 * - `indexprs IS NULL`, i.e. the index is on a **bare column**. This is the load-bearing conjunct:
 *   it is exactly what makes the index unable to serve the folded predicate, and it is what
 *   excludes the replacement, which is an expression index;
 * - the name ends in `_trgm`. This adds nothing to the diagnosis and is there to bound the
 *   *remedy*: without it the probe would tell an operator to drop every bare-column trigram index
 *   in their database, including ones they created deliberately for their own queries. A name is a
 *   weak signal (ADR-0355), and here it is this emitter's own deterministic output, so the error it
 *   can make is to under-report an index renamed by hand -- which costs disk, where over-reporting
 *   would cost somebody else's index. Measured complete for the shipped pack: of the 272 names
 *   resolved `erp-core` emits, **0** are truncated by the 63-character cap (the longest is 42), so
 *   every one of them still ends in the suffix.
 *
 * `pg_catalog` and `information_schema` are excluded because an index there is not ours by
 * construction; `meta` is **not** excluded, and the reason is structural rather than a count. An
 * earlier version of this note said *"measured: 0 gin indexes in `meta` on a freshly applied
 * database"*, and that is **false**: `META_TABLES` declares **three** (`idx_audit_actor`,
 * `idx_feature_flags_environments`, `idx_incidents_tenants`, all `kind: "gin"`). A false measurement
 * defending correct code is ADR-0362's class, so the honest statement is the one that cannot go
 * stale when a fourth lands: the kernel's `IndexSpec` is `{name, columns, unique?, kind?, where?}`
 * and carries **no operator-class field at all**, so a catalogued gin index always emits the default
 * opclass for its column type and `gin_trgm_ops` is not declarable there. The opclass conjunct
 * therefore excludes every catalogued index by construction, and the `_trgm` name conjunct excludes
 * all three a second time. Excluding `meta` by name would be a second list to maintain, with nothing
 * in it.
 */

/** One superseded index, named well enough to drop. */
export interface SupersededTrigramIndex {
  readonly schema: string;
  readonly table: string;
  readonly index: string;
}

/** What the audit established. `null` on `indexes` is the honest arm -- see `auditSupersededTrigramIndexes`. */
export interface SupersededTrigramAudit {
  readonly indexes: readonly SupersededTrigramIndex[] | null;
  /** The driver's message when the catalog could not be read, and null otherwise. */
  readonly detail: string | null;
}

/**
 * `nspname` keeps `pg_catalog`'s own column name rather than aliasing to `schema_name`, and that is
 * not cosmetic. `pg-record-reads.ts` anchors on the catalog — a read is a column read when its
 * property is a catalogued column name — and its soundness rests on a measured premise: every
 * non-column `snake_case` property in the workspace is absent from `META_TABLES`. `schema_name` is
 * a column of `meta.tenants`, so aliasing to it makes this `pg_catalog` row the **first
 * counterexample** to that premise, and the rule then compares `schema_name` against the record's
 * `schema` and reports a divergence it has no catalogued table to adjudicate. The rule's
 * introspection arm exempts a table-less row from `alias_undeclared` and not from the divergence
 * check, so the collision is the thing to remove. A `pg_catalog` alias must not be named after a
 * catalogued column.
 */
interface IndexRow {
  readonly nspname: string;
  readonly table_name: string;
  readonly index_name: string;
}

/** Postgres quotes an identifier with `"`, and doubles an embedded one. */
function quote(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`;
}

/** `DROP INDEX` for one finding, qualified so it is runnable from any search_path. */
export function supersededTrigramDropSql(idx: SupersededTrigramIndex): string {
  return `DROP INDEX IF EXISTS ${quote(idx.schema)}.${quote(idx.index)};`;
}

/**
 * Reads the live catalog for bare-column trigram indexes this emitter no longer writes.
 *
 * `indexes: null` means the read failed, and is not the same claim as `[]` -- which asserts the
 * database holds none (ADR-0331's distinction). It matters here because the two send an operator
 * opposite ways: an empty list is a converged deployment, and a failed read is a reason to look
 * again before believing the disk figures.
 *
 * Read-only, so it is safe on every boot; one catalog query, independent of row counts.
 */
export async function auditSupersededTrigramIndexes(
  conn: PgConnection,
): Promise<SupersededTrigramAudit> {
  try {
    const res = await conn.query<IndexRow>(
      `SELECT n.nspname,
              t.relname AS table_name,
              c.relname AS index_name
         FROM pg_index i
         JOIN pg_class c      ON c.oid = i.indexrelid
         JOIN pg_class t      ON t.oid = i.indrelid
         JOIN pg_namespace n  ON n.oid = c.relnamespace
         JOIN pg_am a         ON a.oid = c.relam
         JOIN pg_opclass oc   ON oc.oid = i.indclass[0]
        WHERE a.amname = 'gin'
          AND oc.opcname = 'gin_trgm_ops'
          AND i.indexprs IS NULL
          AND c.relname LIKE $1
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY n.nspname, t.relname, c.relname`,
      // `_` is a LIKE wildcard, so the suffix's leading underscore is escaped -- without it the
      // pattern would also match a name ending `Xtrgm` for any X, which is the replacement's own
      // `_utrgm`. The expression conjunct already excludes it, so this is the second of two
      // independent reasons the new index can never be reported as superseded.
      [`%${SUPERSEDED_TRIGRAM_SUFFIX.replace("_", String.raw`\_`)}`],
    );
    return {
      indexes: res.rows.map((r) => ({
        schema: r.nspname,
        table: r.table_name,
        index: r.index_name,
      })),
      detail: null,
    };
  } catch (err) {
    return { indexes: null, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The boot sentence, said in all three states.
 *
 * `null` on a converged deployment, so the common case adds no line -- the distinction from the
 * surveys in this binary that speak either way is that those report a *capability*, where this
 * reports leftover disk whose absence is the normal state and says nothing an operator must act on.
 */
export function supersededTrigramLine(audit: SupersededTrigramAudit): string | null {
  if (audit.indexes === null) {
    return (
      "[search] superseded trigram indexes: could not be read, so nothing is claimed about" +
      ` leftover bare-column indexes. (${audit.detail ?? "no detail"})`
    );
  }
  if (audit.indexes.length === 0) return null;
  const drops = audit.indexes.map((i) => supersededTrigramDropSql(i)).join(" ");
  return (
    `[search] ${audit.indexes.length.toString()} superseded bare-column trigram index(es) are` +
    " still present. They are read by no query this binary emits — the substring predicate folds" +
    " accents and a bare-column index cannot serve a folded predicate — while they are maintained" +
    " on every write (measured 13.6x on insert throughput) and can exceed the heap they index." +
    " Nothing drops them automatically, because rebuilding one on a live table is an outage you" +
    ` schedule rather than discover. When you are ready, run: ${drops}`
  );
}
