import type { PgConnection } from "./connection.js";

/**
 * What a zero-row scoped write means, asked of the row rather than guessed.
 *
 * ## The hole this closes
 *
 * ADR-0331 and ADR-0333 swept the **read** side of the owner-bypasses-RLS class. The write side was
 * left open and named: `PostgresFeatureFlagStore.guardedWrite`, `PostgresKillSwitchStore.release`,
 * `PostgresKeyRegistry.markStatus` and `register`, and `PostgresWorkflowDefinitionStore`'s two
 * publication lookups all matched a row by its **unique id alone**. As the owner — who bypasses RLS,
 * which is an ordinary deployment — a platform-scoped write therefore landed on a *tenant's* row.
 *
 * Measured live on a fresh cluster as the owner, before this existed:
 *
 * - `PostgresFeatureFlagStore.update` with `tenantId: null` and a tenant's `flag_id` reported
 *   **success** and rewrote the row's `tenant_id` to `NULL` — the tenant's `checkout.new_pricing`
 *   flag was taken over into platform scope, and its default flipped from `false` to `true`.
 * - `PostgresKeyRegistry.register` with `tenantId: null` and a tenant's `key_id` **replaced the
 *   tenant's public key** through its `ON CONFLICT … DO UPDATE`. That is the table whose write
 *   elevation is its own grant (`app.platform_key_write`, ADR-0332) *precisely* because it holds the
 *   public keys a chain entry's `signingKeyFingerprint` resolves against.
 * - `PostgresKeyRegistry.revoke` revoked a tenant's key, and a `revoke` of an id that exists
 *   **nowhere** also reported success — a zero-row `UPDATE` was silently accepted, so an operator
 *   revoking a compromised key under a mistyped id was told it worked.
 *
 * As the **non-owner** every one of those is refused by RLS, which is why the class is invisible
 * from either vantage alone and why ADR-0333 could call a wrong scope a caller's mistake. It is
 * still a caller's mistake. What it costs is the four lines above.
 *
 * ## Why a diagnosis and not just a predicate
 *
 * Adding `AND <scope>` makes the write safe and makes a zero-row result **ambiguous**: a stale guard
 * and a wrong scope become one `UPDATE 0`. That ambiguity is not hypothetical and not new — measured
 * as the non-owner, where RLS already refused the cross-scope write, `FeatureFlagConflictError`
 * answered *"another writer changed it first"* about a row no writer had touched. So the predicate
 * does not create the ambiguity; it makes it reachable for the owner too, and this resolves it for
 * both.
 *
 * The shape is ADR-0333's `refuseUnlessWritten` in `dr-runtime-pg`: **re-read the row on the failure
 * path only** and raise a typed error naming which rule refused. One extra statement, never on the
 * happy path. The re-read deliberately carries **no scope predicate**, because the whole question is
 * whether the row is sitting in another scope — reading it through the scope that just failed could
 * only answer "absent".
 *
 * ## What a non-owner sees
 *
 * `wrong_scope` is reachable only where the cross-scope write itself was: as a non-owner, RLS
 * refused the write *and* confines this re-read, so the answer is `row_absent`. That is not a
 * degradation to apologise for — it is the truth from that session's vantage, and it is the honest
 * report of a statement that never had a route to the row. Verified in both directions.
 */
export const SCOPED_WRITE_REFUSALS = [
  /** No row anywhere carries this id — in this session's vantage. */
  "row_absent",
  /** The row exists and belongs to a different scope than the write named. */
  "wrong_scope",
  /** The row exists in this scope; whatever else the statement guarded on refused it. */
  "guard_refused",
] as const;

export type ScopedWriteRefusal = (typeof SCOPED_WRITE_REFUSALS)[number];

/**
 * Identifiers are interpolated into the re-read, so they are checked rather than trusted. Every
 * caller passes a module constant, which is why this is a fail-fast and not a sanitiser: a value
 * that fails it is a bug in the store, not hostile input.
 */
const BARE_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

function identifier(value: string, what: string): string {
  if (!BARE_IDENTIFIER_RE.test(value)) {
    throw new Error(`${what} is not a bare identifier: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * What the re-read found, for a store that raises its own error type.
 *
 * The classify/throw split exists so the reason reaches a caller **through the error it already
 * catches**. `FeatureFlagConflictError` and `KillSwitchNotFoundError` are part of their package's
 * public surface and a catcher of either would be broken by a new unrelated class, so they stay and
 * gain a `reason` instead. A store with no error of its own calls `assertScopedWriteLanded`.
 */
export interface ScopedWriteRefusalReport {
  readonly reason: ScopedWriteRefusal;
  /** `meta.feature_flags` — schema and table, as the store names them. */
  readonly target: string;
  /** The scope the stored row is actually in, or `null` when it is the platform's or absent. */
  readonly storedTenantId: string | null;
  /** One sentence naming the rule that refused, ready to end a message with. */
  readonly detail: string;
}

export class ScopedWriteRefusedError extends Error {
  constructor(
    readonly target: string,
    readonly rowId: string,
    readonly reason: ScopedWriteRefusal,
    /** The scope the write named: a tenant id, or `null` for the platform scope. */
    readonly scopeTenantId: string | null,
    /** The scope the stored row is actually in, where one was found. */
    readonly storedTenantId: string | null,
    detail: string,
  ) {
    super(`${target}: refused write to ${rowId} (${reason}): ${detail}`);
    this.name = "ScopedWriteRefusedError";
  }
}

export interface ScopedWriteDiagnosis {
  readonly schema: string;
  readonly table: string;
  /** The column the statement matched the row on — `flag_id`, `kill_switch_id`, `key_id`. */
  readonly idColumn: string;
  readonly idValue: string;
  /** The scope the statement wrote in: a tenant id, or `null` for the platform scope. */
  readonly tenantId: string | null;
  /**
   * What the statement guarded on *besides* the scope, in the store's own words — the sentence a
   * `guard_refused` message ends with. Naming it here rather than composing a generic one is what
   * keeps `updated_at` conflicts, status transitions and publication status distinguishable in a
   * log, since all three reach this with the same row count.
   */
  readonly guard: string;
}

function scopeLabel(tenantId: string | null): string {
  return tenantId === null ? "the platform scope" : `tenant ${tenantId}`;
}

/**
 * Asks the row which rule refused a scoped write, and answers `null` when none did.
 *
 * Issues nothing when the write landed, so the cost is one statement on the failure path and
 * nothing at all otherwise.
 */
export async function classifyScopedWriteRefusal(
  tx: PgConnection,
  rowCount: number | null | undefined,
  d: ScopedWriteDiagnosis,
): Promise<ScopedWriteRefusalReport | null> {
  if ((rowCount ?? 0) > 0) return null;
  const target = `${identifier(d.schema, "schema")}.${identifier(d.table, "table")}`;
  const idColumn = identifier(d.idColumn, "id column");
  // No scope predicate, deliberately: the question this answers is whether the row is in *another*
  // scope, and a scoped read could only ever say "absent".
  const result = await tx.query<Record<string, unknown>>(
    `SELECT tenant_id FROM ${target} WHERE ${idColumn} = $1`,
    [d.idValue],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return {
      reason: "row_absent",
      target,
      storedTenantId: null,
      detail: `no row carries ${idColumn} = ${JSON.stringify(d.idValue)} in any scope this session can read`,
    };
  }
  const stored =
    row["tenant_id"] === null || row["tenant_id"] === undefined
      ? null
      : String(row["tenant_id"]);
  if (stored !== d.tenantId) {
    return {
      reason: "wrong_scope",
      target,
      storedTenantId: stored,
      detail: `the write named ${scopeLabel(d.tenantId)} and the row belongs to ${scopeLabel(stored)}`,
    };
  }
  return {
    reason: "guard_refused",
    target,
    storedTenantId: stored,
    detail: `the row is in ${scopeLabel(stored)} as the write named, so ${d.guard}`,
  };
}

/**
 * `classifyScopedWriteRefusal` for a store with no error type of its own: raises
 * `ScopedWriteRefusedError`, or returns having issued nothing.
 */
export async function assertScopedWriteLanded(
  tx: PgConnection,
  rowCount: number | null | undefined,
  d: ScopedWriteDiagnosis,
): Promise<void> {
  const report = await classifyScopedWriteRefusal(tx, rowCount, d);
  if (report === null) return;
  throw new ScopedWriteRefusedError(
    report.target,
    d.idValue,
    report.reason,
    d.tenantId,
    report.storedTenantId,
    report.detail,
  );
}
