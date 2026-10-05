import type { TableDefinition } from "@crossengin/kernel/bootstrap";

/**
 * Which columns of a catalog table **must** appear in every `INSERT`, and how to read the column
 * list back out of a recorded statement.
 *
 * This exists because of what the offline fakes cannot see. A fake `PgConnection` records
 * `{sql, params}` and a test asserts on the SQL's *shape* — so a store that never names a NOT NULL
 * column passes every one of its tests and throws on the first real row. That was true of
 * `PostgresSignalStore` (ADR-0331), of `PostgresTimerStore` and `PostgresActivityStore` (both
 * omitting NOT NULL columns with no default), and of `PostgresFeatureFlagStore`, whose column list
 * named `default_value` after the catalog had renamed it (ADR-0332).
 *
 * The durable fix is not a longer offline test; it is to stop restating the catalog. These helpers
 * compute the requirement **from `META_TABLES`**, so a column added to a table with `notNull` and
 * no default fails the store's test on the next run rather than on the next deployment.
 *
 * **Not a second copy of `packages/testing`'s `pg-column-coverage`.** That one is the workspace
 * sweep: a static scan over every package's source text, asserting no `INSERT` anywhere omits a
 * required column — broader, and the right place for the rule. This one is narrower and asks a
 * question the static scan cannot: it reads the SQL the store *actually executed*, after the schema
 * identifier is interpolated, and so can also check that the bound parameters number exactly as
 * many as the columns named. The two agree by construction, since both read `META_TABLES`.
 */

/**
 * A column counts as required exactly when the database would refuse an `INSERT` that omits it:
 * `notNull` and no `default`. A generated or defaulted column (`id`, `timezone`, `fire_count`) is
 * not required even though it is NOT NULL, because Postgres fills it.
 */
export function requiredColumnNames(table: TableDefinition): readonly string[] {
  return table.columns
    .filter((c) => c.notNull === true && c.default === undefined)
    .map((c) => c.name);
}

/**
 * The column names an `INSERT INTO <schema>.<table> ( … )` statement lists, in order.
 *
 * Deliberately a parse of the recorded SQL rather than a second list maintained beside the store:
 * a maintained list is what ADR-0288's `needsAuditEmitter` was, and a test over a hand-kept copy
 * cannot catch a column missing from both copies of itself. Throws rather than answering `[]` for a
 * statement it cannot read — an empty answer would make every assertion below vacuously pass.
 */
export function insertColumnList(sql: string): readonly string[] {
  const insertAt = sql.indexOf("INSERT INTO");
  if (insertAt === -1) throw new Error(`not an INSERT statement: ${sql.slice(0, 80)}`);
  const open = sql.indexOf("(", insertAt);
  if (open === -1) throw new Error(`INSERT names no columns: ${sql.slice(0, 80)}`);
  // `INSERT INTO t VALUES ($1)` names no columns at all, and its first paren opens the *values*
  // tuple — which would read back as a column called `$1`. Caught here rather than yielding a
  // nonsense list, since a wrong list is as vacuous as an empty one.
  const valuesAt = sql.indexOf("VALUES", insertAt);
  if (valuesAt !== -1 && valuesAt < open) {
    throw new Error(`INSERT names no columns: ${sql.slice(0, 80)}`);
  }
  const close = sql.indexOf(")", open);
  if (close === -1) throw new Error(`unterminated INSERT column list: ${sql.slice(0, 80)}`);
  return sql
    .slice(open + 1, close)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Required columns of `table` that `sql` does not name. Empty is the only passing answer. */
export function missingRequiredColumns(
  table: TableDefinition,
  sql: string,
): readonly string[] {
  const named = new Set(insertColumnList(sql));
  return requiredColumnNames(table).filter((name) => !named.has(name));
}
