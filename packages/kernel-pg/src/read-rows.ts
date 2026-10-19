/**
 * What a multi-row read does with a row its contract refuses.
 *
 * ADR-0372 established the rule for three reads in one store and ADR-0373 found 51 sites with the
 * shape: **a sweep reports an unrepresentable row and carries on; it does not take the other rows
 * with it.** `result.rows.map(rowToX)` is the defect, because `rowToX` ends in `XSchema.parse` and a
 * parse failure is a *finding* (ADR-0289: a row edited into a state the contract forbids and a CHECK
 * permits), so throwing it out of the array converts one finding into the loss of every other row's.
 *
 * Lifted here rather than copied per store for `scopeFilter`'s reason (ADR-0334): eight copies of
 * one rule is where two of them eventually disagree, and this module is the one every `*-pg` member
 * already imports for `PgConnection`.
 *
 * **Two legitimate answers, and the store's own contract says which.** A store whose consumer is a
 * scheduler or a route *forwards* the reporter, so the caller decides what a finding is worth
 * (ADR-0372's three list methods). A store whose consumer is a **verifier** collects the reports and
 * returns them beside the records, because there the unreadable row is not a note on the side — it
 * is part of the answer, and a verdict computed over the readable rows alone is a verdict about a
 * different set of rows than the one on disk.
 */

import { ZodError } from "zod";

/**
 * One row of a multi-row read that could not be represented.
 *
 * Two fields and no more. `identity` is the row's business key — what a `WHERE` clause needs and the
 * only handle a remedy can name — and `detail` is the cause. Every *other* column of a refused row
 * is of unestablished trustworthiness, so reporting one invites an operator to scope a manual fix by
 * a value that may be the reason the row was refused (ADR-0310's rule about what a finding's notice
 * may carry).
 *
 * `identity` is `string | null` because the identifying column may itself be what is wrong, and
 * `null` says *the row does not name one* rather than inventing a handle (ADR-0331).
 */
export interface UnreadableRow {
  readonly identity: string | null;
  readonly detail: string;
}

/**
 * What a read does with a row it cannot represent.
 *
 * **Required** wherever it appears, never optional with a default: a reporter defaulting to "drop it
 * silently" is the defect restated as a default (ADR-0364's addendum, ADR-0371's `onRefused`).
 * Required also means the compiler names every call site when a read is added, where a
 * constructor-level reporter would let a new method inherit one nobody chose.
 */
export type UnreadableRowReporter = (row: UnreadableRow) => void;

/**
 * Why the contract refused a row, in terms that name no value from it.
 *
 * A `ZodError`'s own `message` is the JSON of its issues, and an `invalid_enum_value` issue carries
 * `received` — the stored value. That value then travels into a log line, an HTTP body or an
 * incident note, which is the disclosure ADR-0367 converted six interpolated refusal strings into
 * literals to stop. So the detail is the **field path and the issue code**: `kind:
 * invalid_enum_value` sends a reader to the one column to look at and discloses nothing about what
 * it holds. A path-less issue (a failed object-level refinement) reads `<root>`, because an empty
 * string would render as a stray separator.
 *
 * ADR-0372's own `detail` is `err.message`, so this is a correction to it found by generalising it:
 * that module argues at length that no other column of a refused row may be reported and then
 * reports whichever one zod quoted.
 */
export function unreadableDetail(err: unknown): string {
  if (err instanceof ZodError) {
    const issues = err.issues.map(
      (issue) => `${issue.path.length === 0 ? "<root>" : issue.path.join(".")}: ${issue.code}`,
    );
    // Sorted and de-duplicated so the same defect reads the same whatever order zod walked the
    // object in — a detail that varies run to run cannot be compared across two sweeps.
    const unique = [...new Set(issues)].sort();
    return unique.length === 0 ? "unparseable" : unique.join(", ");
  }
  if (err instanceof Error) {
    // A non-zod throw is a mapper's own guard (`requireIso` and its siblings), whose messages are
    // written in this repo and name no row value.
    return err.message;
  }
  return "unparseable";
}

/**
 * Every row of a page the contract can represent, with a report for every row it cannot.
 *
 * `identify` is separate from `map` on purpose: it reads the business key **straight off the raw
 * row**, so it still answers for a row the mapper refused — which is the one field a finding needs
 * and the one the mapper cannot supply.
 *
 * Generic in the **row** type as well as the record's, because a store that types its rows
 * (`tx.query<Row>`) could not use this otherwise: a function parameter is contravariant, so an
 * `interface Row` with no index signature is assignable to neither `Record<string, unknown>` nor a
 * parameter of that type, and the first slice to meet it wrote a second copy of this loop rather
 * than widen its own mapper. `R extends object` rather than `unknown` so `row[column]` stays an
 * error in `textIdentity`'s position, where the column name is a string nobody checked.
 */
export function readRows<R extends object, T>(
  rows: readonly R[],
  map: (row: R) => T,
  identify: (row: R) => string | null,
  onUnreadable: UnreadableRowReporter,
): readonly T[] {
  const out: T[] = [];
  for (const row of rows) {
    try {
      out.push(map(row));
    } catch (err) {
      // `identify` runs inside the catch rather than before the map, so a throw from it cannot cost
      // the rows after this one — and it is reported as an unidentified row rather than as a page
      // that could not be read.
      let identity: string | null = null;
      try {
        identity = identify(row);
      } catch {
        identity = null;
      }
      onUnreadable({ identity, detail: unreadableDetail(err) });
    }
  }
  return out;
}

/**
 * `readRows` for a reader whose consumer is a verifier: the unreadable rows come back beside the
 * records instead of through a callback.
 *
 * The distinction is not stylistic. A callback hands the fact to whoever called *this* method, and
 * for a verification the fact has to reach the function that computes the verdict — which is often
 * two layers up and pure. Returning the pair makes a caller that wants only the records write
 * `.records`, which is visible in review and in a grep, where a discarded callback is not.
 */
export interface RowRead<T> {
  readonly records: readonly T[];
  readonly unreadable: readonly UnreadableRow[];
}

export function readRowsWithUnreadable<R extends object, T>(
  rows: readonly R[],
  map: (row: R) => T,
  identify: (row: R) => string | null,
): RowRead<T> {
  const unreadable: UnreadableRow[] = [];
  const records = readRows(rows, map, identify, (row) => unreadable.push(row));
  return { records, unreadable };
}

/** Best-effort handle for a row the contract refused: the column may be the reason it was refused. */
export function textIdentity(row: Record<string, unknown>, column: string): string | null {
  const raw = row[column];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * The same for an integer key. Separate from `textIdentity` because a `BIGINT` arrives as a string
 * from node-postgres while an `INTEGER` arrives as a number (ADR-0331), so one predicate over
 * `typeof` would answer for one of the two and not the other.
 */
export function numericIdentity(row: Record<string, unknown>, column: string): string | null {
  const raw = row[column];
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "string" && raw.length > 0 && Number.isFinite(Number(raw))) return raw;
  return null;
}
