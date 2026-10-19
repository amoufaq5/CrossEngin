/**
 * The one thing a fake `PgConnection` cannot learn by interpreting SQL: whether the statement and
 * its parameter array agree about how many parameters there are.
 *
 * Postgres answers that in the **bind** step, before the planner sees the statement, so it is not
 * a question about tables, columns, types or rows — the subjects of every rule in `strategy/`. A
 * fake that reads the SQL and serves rows from a model of the table is still answering a statement
 * no real server would have accepted:
 *
 * - more parameters bound than referenced → `08P01 bind message supplies N parameters, but
 *   prepared statement "" requires M`
 * - a referenced position past the end of the array → `42P18 could not determine data type of
 *   parameter $N`
 *
 * Both were live on all five of `meta.notification_templates`' status transitions (ADR-0370): one
 * arm of a `switch` referenced a fixed `$5` that the caller pushed unconditionally, so the four
 * arms that did not mention it bound a parameter the statement never referenced. The store's own
 * fake models that table's RLS policy and its rows, and saw none of it, because there is no bind
 * step to model.
 *
 * So the predicate is deliberately **both ways**, which is this repo's rule wherever two halves of
 * one fact are compared (`pg-record-retention.ts`): the referenced set must be exactly
 * `{1..params.length}`. A one-way check would pass the `08P01` case, which is the one that had four
 * members.
 */

/** The placeholder positions a statement references, in ascending order, de-duplicated. */
export function referencedParamPositions(sql: string): readonly number[] {
  const seen = new Set<number>();
  // `$$`-quoted bodies are the one place a `$n` can appear without being a placeholder, and a
  // plpgsql `DO` block is exactly that shape. Blanking those first keeps the predicate honest
  // about `kernel-pg`'s guards, which embed statements inside `DO $ce$ … $ce$`.
  // The closing tag must match the opening one exactly, which is why this is two alternatives and
  // not one with an optional back-reference: `$a$ p $$ q $a$` under the looser form stops at the
  // bare `$$` and leaves the tail unscrubbed, so a `$1` inside the body would be reported as a
  // position the bind step never sees — a false positive, the one direction a fence must not fail.
  const scrubbed = sql.replace(/\$\$[\s\S]*?\$\$|\$([A-Za-z_]\w*)\$[\s\S]*?\$\1\$/g, " ");
  for (const m of scrubbed.matchAll(/\$(\d+)/g)) {
    const n = Number.parseInt(m[1] ?? "", 10);
    if (Number.isInteger(n) && n > 0) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

export interface BindArityMismatch {
  /** Positions the statement references that the parameter array does not supply (`42P18`). */
  readonly unsupplied: readonly number[];
  /** Positions the parameter array supplies that the statement never references (`08P01`). */
  readonly unreferenced: readonly number[];
}

/**
 * `null` when the statement references exactly the parameters it is given.
 *
 * Reported rather than thrown, so a caller decides: a fake raises (a statement no server would
 * accept must not be served), while a survey over many statements wants to collect them.
 */
export function bindArityMismatch(
  sql: string,
  params: readonly unknown[] | undefined,
): BindArityMismatch | null {
  const supplied = params?.length ?? 0;
  const referenced = referencedParamPositions(sql);
  const unsupplied = referenced.filter((n) => n > supplied);
  const referencedSet = new Set(referenced);
  const unreferenced: number[] = [];
  for (let n = 1; n <= supplied; n += 1) if (!referencedSet.has(n)) unreferenced.push(n);
  if (unsupplied.length === 0 && unreferenced.length === 0) return null;
  return { unsupplied, unreferenced };
}

/**
 * Raise unless the statement references exactly the parameters it binds.
 *
 * Call this from a fake's `query` before it serves anything. The message names the real Postgres
 * error code the live server would have answered with, because that is what sends a reader to the
 * cause rather than to the fake.
 */
export function assertBindArity(sql: string, params?: readonly unknown[]): void {
  const mismatch = bindArityMismatch(sql, params);
  if (mismatch === null) return;
  const supplied = params?.length ?? 0;
  const parts: string[] = [];
  if (mismatch.unreferenced.length > 0) {
    parts.push(
      `08P01: binds ${supplied.toString()} parameters and references ` +
        `${referencedParamPositions(sql).length.toString()} — ` +
        `$${mismatch.unreferenced.join(", $")} referenced by nothing`,
    );
  }
  if (mismatch.unsupplied.length > 0) {
    parts.push(
      `42P18: references $${mismatch.unsupplied.join(", $")} past the end of a ` +
        `${supplied.toString()}-parameter array`,
    );
  }
  throw new Error(`${parts.join("; ")}\n  statement: ${sql.replace(/\s+/g, " ").trim()}`);
}
