import {
  numericIdentity,
  readRowsWithUnreadable,
  unreadableDetail,
  type PgConnection,
  type RowRead,
  type UnreadableRow,
} from "@crossengin/kernel-pg";
import { ChainCheckpointSchema, type ChainCheckpoint } from "@crossengin/forensics";

import {
  scopeFilter,
  SET_PLATFORM_AUDIT_WRITE_SQL,
  withTenantContext,
} from "./tenant-context.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const TABLE = "forensic_chain_checkpoints";

const READ_COLUMNS = `sequence_number, root_hash, checkpointed_at, checkpointed_by,
  external_anchor_reference, algorithm, provenance`;

const DEFAULT_LIST_LIMIT = 50;

/**
 * The tiebreaker among rows at **one** sequence, which `UNIQUE (tenant_id, sequence_number)` does
 * not prevent for the platform scope: SQL treats NULLs as distinct, so `(NULL, 3)` and `(NULL, 3)`
 * are two legal rows and the `ON CONFLICT` arm below never fires for a platform checkpoint.
 * Measured live on PG 16.13 — two rows at the same platform sequence, and ten runs of the
 * untiebroken query returned the **older** one every time (ADR-0371).
 *
 * That order is the fail-open one, which is why this is a correctness fix rather than tidying: an
 * anchor's `provenance` is what a bounded proof takes its prefix on trust from, so a stale
 * `verified_full` masking a later `unverified` would license exactly the skip the provenance exists
 * to refuse. Newest-first means a later verdict about one sequence supersedes an earlier one, and
 * the direction a mistake falls in is toward re-folding. `id` is the total tiebreaker (uuidv7, so
 * time-ordered) for two rows stamped in the same transaction.
 */
const NEWEST_AT_ONE_SEQUENCE = "checkpointed_at DESC, id DESC";

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Postgres `CHAR(64)` right-pads with spaces; sha256 hex is exactly 64 chars, but trim defensively. */
export function rowToCheckpoint(row: Record<string, unknown>): ChainCheckpoint {
  const anchor = row["external_anchor_reference"];
  const algorithm = row["algorithm"];
  const provenance = row["provenance"];
  // An out-of-enum provenance is handed to the parse to refuse rather than coerced to `undefined`:
  // absent says this row's columns do not cover the question, which is false of a row that answered
  // it and said something this binary does not know.
  return ChainCheckpointSchema.parse({
    sequenceNumber: Number(row["sequence_number"] ?? 0),
    rootHash: String(row["root_hash"]).trim(),
    checkpointedAt: asIso(row["checkpointed_at"]),
    checkpointedBy: String(row["checkpointed_by"]),
    externalAnchorReference: anchor == null ? undefined : String(anchor),
    algorithm: algorithm == null ? undefined : String(algorithm),
    provenance: provenance == null ? undefined : String(provenance),
  });
}

/**
 * A stored checkpoint exists and the contract refuses it — the **third** answer `latest` owes, and
 * the one its two outcomes could not express.
 *
 * It is a throw and not a widened return, which is ADR-0373's rule rather than this module's
 * preference: a single-row read that throws is correct, because the caller asked about *that row*
 * and must not be served past it. What was wrong was the **kind** of throw — a bare `ZodError`,
 * which a caller cannot classify (`record`'s own input parse raises the same type) and whose
 * `message` is the JSON of its issues, so an `invalid_enum_value` carries the stored value into
 * whatever log line, HTTP body or incident note catches it. Measured live as a non-owner: blanking
 * `checkpointed_by` through the tenant isolation arm made the hourly integrity pass file
 * `outcome: "error"` with that JSON on the `onError` line, and nothing else.
 *
 * **`null` is refused, and the measurement is what refuses it.** `null` means *no checkpoint for
 * this scope*, which `CHAIN_FULL_REASONS` describes as a condition that "heals on the next
 * scheduler pass" — and this one cannot, because `record` is `ON CONFLICT (tenant_id,
 * sequence_number) DO NOTHING`, so a pass anchoring at the same tail answers `INSERT 0 0` and the
 * refused row stays (verified live). Reporting a self-healing condition for a permanent one is
 * ADR-0334's remedy-that-cannot-work. It is also ADR-0331's rule at this seam: *there is no row* and
 * *this binary cannot read the row there is* are different facts with different remedies, and the
 * second is the stronger of the two, because `record` begins `ChainCheckpointSchema.parse`, so no
 * write this binary performs can produce one.
 *
 * The identity is the row's `sequence_number` and no other column — `UnreadableRow`'s rule: the
 * business key is what a `WHERE` clause needs and the only handle a remedy can name, while every
 * other column of a refused row is of unestablished trustworthiness. `detail` comes from
 * `unreadableDetail`, so it names the field path and the issue code and no value from the row.
 */
export class CheckpointRowUnreadable extends Error {
  constructor(
    readonly scope: string | null,
    readonly row: UnreadableRow,
  ) {
    super(
      `the ${scope === null ? "platform" : scope} chain's checkpoint at sequence ` +
        `${row.identity ?? "<unidentified>"} is stored in a shape the contract refuses ` +
        `(${row.detail}), so nothing can be read from the anchor it is. Fold from genesis for this ` +
        `scope and go and look at that row.`,
    );
    this.name = "CheckpointRowUnreadable";
  }
}

/**
 * One spelling of the single-row read's refusal, so `latest` and `getBySequence` cannot come to
 * disagree about what one is. The identity is read **off the raw row** rather than from the mapper,
 * which is the whole reason it still answers for a row the mapper refused.
 */
function readOne(
  scope: string | null,
  row: Record<string, unknown> | undefined,
): ChainCheckpoint | null {
  if (row === undefined) return null;
  try {
    return rowToCheckpoint(row);
  } catch (err) {
    throw new CheckpointRowUnreadable(scope, {
      identity: numericIdentity(row, "sequence_number"),
      detail: unreadableDetail(err),
    });
  }
}

export interface PostgresChainCheckpointStoreOptions {
  readonly schema?: string;
}

/**
 * Persists anchored `ChainCheckpoint`s into `meta.forensic_chain_checkpoints` and reads them back scoped to
 * a tenant (or the platform, `tenantId = null`). Append-only: a re-`record` of an existing
 * `(tenant, sequence)` is a no-op (`ON CONFLICT DO NOTHING`).
 *
 * That now also means a `provenance` cannot be upgraded in place, which is the point rather than a
 * limitation: a `DO UPDATE` arm here would let an `unverified` anchor become a trusted one without
 * anything having verified the prefix — ADR-0371's defect by another route, and reachable by anyone
 * who can write a checkpoint at all. A better-verified anchor is a new checkpoint at the new tail.
 *
 * **Append-only is a property of this store and not of the table**, and the distinction is the one
 * ADR-0374 measured: `forensic_chain_checkpoints`' isolation policy is `ALL`-scope, so its `USING`
 * doubles as its `WITH CHECK` and a *tenant-context* session may `UPDATE` or `DELETE` its own
 * checkpoint row — verified live as the non-owner `serving` role. ADR-0332's split made the
 * **platform** arm append-only (a `SELECT` read and an `INSERT` write, no `UPDATE`), and nothing
 * covers the tenant arm. So the fences that hold here are the column CHECKs and the read refusals
 * below, not the policy.
 *
 * Each read therefore has a third answer, and which one it gives is decided by how many rows the
 * caller asked about (ADR-0373): `latest` and `getBySequence` throw `CheckpointRowUnreadable`,
 * because a caller asking about one row must not be served past it, while `listRecent` returns the
 * readable rows beside the refused ones, because a page that throws takes every other row's finding
 * with it.
 *
 * Scope is both an RLS elevation and a bound predicate, for the two separate reasons the chain store
 * gives: the owner bypasses RLS, so a read with no predicate crossed scopes (a tenant's
 * `latest()` could return the *platform's* newest checkpoint, which is the witness a truncation check
 * is measured against — ADR-0287); and a platform **write** needs its own elevation, because the
 * platform arm used to sit inside the tenant isolation policy where an `ALL` policy's `USING` doubles
 * as its `WITH CHECK`.
 */
export class PostgresChainCheckpointStore {
  private readonly schema: string;

  constructor(
    private readonly conn: PgConnection,
    options: PostgresChainCheckpointStoreOptions = {},
  ) {
    this.schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(this.schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(this.schema)}`);
    }
  }

  async record(tenantId: string | null, checkpoint: ChainCheckpoint): Promise<void> {
    const valid = ChainCheckpointSchema.parse(checkpoint);
    await this.scoped(tenantId, "write", (conn) =>
      conn.query(
        `INSERT INTO ${this.schema}.${TABLE}
          (tenant_id, sequence_number, root_hash, checkpointed_at, checkpointed_by,
           external_anchor_reference, algorithm, provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, sequence_number) DO NOTHING`,
        [
          tenantId,
          valid.sequenceNumber,
          valid.rootHash,
          valid.checkpointedAt,
          valid.checkpointedBy,
          valid.externalAnchorReference ?? null,
          valid.algorithm,
          valid.provenance ?? null,
        ],
      ),
    );
  }

  async latest(tenantId: string | null): Promise<ChainCheckpoint | null> {
    const scope = scopeFilter(tenantId);
    return this.scoped(tenantId, "read", async (conn) => {
      const result = await conn.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE ${scope.sql} ORDER BY sequence_number DESC, ${NEWEST_AT_ONE_SEQUENCE} LIMIT 1`,
        scope.params,
      );
      return readOne(tenantId, result.rows[0]);
    });
  }

  async getBySequence(
    tenantId: string | null,
    sequenceNumber: number,
  ): Promise<ChainCheckpoint | null> {
    const scope = scopeFilter(tenantId, 2);
    return this.scoped(tenantId, "read", async (conn) => {
      const result = await conn.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE sequence_number = $1 AND ${scope.sql} LIMIT 1`,
        [sequenceNumber, ...scope.params],
      );
      return readOne(tenantId, result.rows[0]);
    });
  }

  /**
   * The checkpoint history, newest first — the **pair** form, so a refused row comes back beside the
   * records instead of taking them with it.
   *
   * It was `result.rows.map(rowToCheckpoint)`, which is ADR-0373's defect exactly: the mapper ends
   * in a `.parse`, so one refused row threw the whole page out and every other row's finding with
   * it. The two single-row reads above are *right* to throw and this one is not, which is the
   * distinction that increment is about.
   *
   * **The pair form rather than a reporter**, and that was decided by looking for the consumer and
   * finding none — this method has zero non-test callers. So it is decided by the store's
   * character: both of `latest`'s consumers are **verifiers** (`verifyChainFromCheckpoint` and
   * `proveScopeIntegrity`'s truncation check), and this table's whole purpose is to witness a
   * verification, so the caller this will gain is one computing a verdict — where the refused row is
   * part of the answer and not a note on the side. The pair also makes a caller's *drop* visible: it
   * has to write `.records`, which shows up in review and in a grep, where a discarded callback does
   * not. ADR-0373's `tombstone-store::listForTenant` note is the precedent for deferring the
   * question to the caller's kind; the cost of deferring the *shape* is that nothing routes the row
   * at all, which is what this closes.
   */
  async listRecent(
    tenantId: string | null,
    limit: number = DEFAULT_LIST_LIMIT,
  ): Promise<RowRead<ChainCheckpoint>> {
    const scope = scopeFilter(tenantId, 2);
    return this.scoped(tenantId, "read", async (conn) => {
      const result = await conn.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE ${scope.sql} ORDER BY sequence_number DESC, ${NEWEST_AT_ONE_SEQUENCE} LIMIT $1`,
        [limit, ...scope.params],
      );
      return readRowsWithUnreadable(result.rows, rowToCheckpoint, (row) =>
        numericIdentity(row, "sequence_number"),
      );
    });
  }

  /**
   * Opens the transaction one call runs in under the elevation its scope and access need.
   *
   * A platform **read** needs none: the platform arm of the read policy is open to every scope, as
   * it has always been. A platform **write** needs `app.platform_audit_write`, and asking for it per
   * call rather than per store is what keeps a read transaction unable to insert.
   */
  private scoped<T>(
    tenantId: string | null,
    access: "read" | "write",
    fn: (conn: PgConnection) => Promise<T>,
  ): Promise<T> {
    if (tenantId !== null) return withTenantContext(this.conn, tenantId, fn);
    if (access === "read") return this.conn.transaction(fn);
    return this.conn.transaction(async (tx) => {
      await tx.query(SET_PLATFORM_AUDIT_WRITE_SQL);
      return fn(tx);
    });
  }
}
