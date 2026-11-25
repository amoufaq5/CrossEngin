import type { UniqueIndexRefusalCause } from "@crossengin/operate-runtime-pg";

import type { ObservedUniqueRefusal } from "./unique-enforcement.js";

/**
 * The one sentence a refused `CREATE UNIQUE INDEX` on the column store gets, wherever it is printed.
 *
 * Both boot-time sites used to say *"the duplicate rows are already there … Deduplicate, then run"*
 * for every refusal, and that sentence is true of exactly one cause. Since ADR-0425 a boot statement
 * runs under a `lock_timeout` and a `statement_timeout`, so a unique index on a table some other
 * session holds — or on a large table that outruns the timeout — is refused with `55P03` or `57014`
 * having read **no** row: telling the operator to deduplicate sends them to hunt for duplicates that
 * may not exist, and the real remedy (retry when the lock is gone, or run the statement by hand) is not on
 * the line at all. ADR-0334's rule: a remedy that cannot work is worse than none.
 *
 * A total map over the cause, so a fourth cause is a compile error here until it says what to do.
 */
export const UNIQUE_INDEX_REFUSAL_SENTENCE: Readonly<
  Record<UniqueIndexRefusalCause, { readonly why: string; readonly remedy: string }>
> = {
  duplicates: {
    why: "rows already in the table share a value of it within a tenant, so the index could not be built",
    remedy: "deduplicate those rows, then restart or run",
  },
  timed_out: {
    why:
      "the CREATE UNIQUE INDEX waited on a lock another session held, or ran past the statement" +
      " timeout, and was abandoned — no row was read, so nothing here says there are duplicates",
    // No flag is named, because none governs the arm that prints this most: the boot store and the
    // `column-schema` step build the index through `applyBootStatement`, whose `SET LOCAL` bounds
    // are fixed and override the session's `--pg-lock-timeout-ms` / `--pg-statement-timeout-ms`.
    // An earlier draft named those flags here, which is a remedy that cannot work for a boot
    // (ADR-0334); they do govern a tenant application, which runs on the serving session, so the
    // sentence says where each arm's bound comes from rather than which knob to turn.
    remedy:
      "restart once nothing holds a lock on the table (a boot's DDL bounds are fixed and no flag" +
      " raises them; a tenant application's are the serving session's), or, for a table too large" +
      " to index within them, run",
  },
  other: {
    why: "Postgres refused the index for the reason quoted",
    remedy: "act on that reason, then restart or run",
  },
};

export interface UniqueIndexRefusalLine {
  readonly entity: string;
  readonly field: string;
  readonly cause: UniqueIndexRefusalCause;
  /** The store's own detail — the database's message, which names a constraint and not a value. */
  readonly detail: string;
  readonly sql: string;
}

/**
 * Renders one refusal. `where` names whose schema it is (`boot` or a tenant id with its schema) so a
 * multi-tenant log line is attributable without its neighbours.
 */
export function formatUniqueIndexRefusal(where: string, refusal: UniqueIndexRefusalLine): string {
  const { why, remedy } = UNIQUE_INDEX_REFUSAL_SENTENCE[refusal.cause];
  return (
    `[unique] ${where} ${refusal.entity}.${refusal.field}: a declared unique field is NOT enforced` +
    ` (${refusal.cause}) — ${why}: ${refusal.detail}. To enforce it, ${remedy}: ${refusal.sql}`
  );
}

/**
 * The boot survey's reason for a refusal the column store's applying arm observed, so the
 * `unique enforcement` line counts it as withheld instead of reporting every planned index as
 * enforced (ADR-0440 Q9). `timed_out` is its own reason there for the same reason it is its own
 * sentence here.
 */
export const UNIQUE_INDEX_REFUSAL_REASON: Readonly<
  Record<UniqueIndexRefusalCause, ObservedUniqueRefusal["reason"]>
> = {
  duplicates: "existing_duplicates",
  timed_out: "index_timed_out",
  other: "index_failed",
};

export function observedUniqueRefusal(refusal: {
  readonly entity: string;
  readonly field: string;
  readonly cause: UniqueIndexRefusalCause;
}): ObservedUniqueRefusal {
  return {
    entity: refusal.entity,
    field: refusal.field,
    reason: UNIQUE_INDEX_REFUSAL_REASON[refusal.cause],
  };
}
