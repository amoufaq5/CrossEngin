import type { PgConnection } from "@crossengin/kernel-pg";
import {
  NotificationReadStateSchema,
  NotificationReadWatermarkSchema,
  type InboxViewer,
  type NotificationReadState,
  type NotificationReadWatermark,
  type ReadStateIndex,
  type ReadStateSource,
  indexReadState,
} from "@crossengin/notifications";
import { withTenantContext } from "@crossengin/operate-runtime-pg";

/**
 * The writer `meta.notification_read_states` and `meta.notification_read_watermarks` never had.
 *
 * ADR-0309 modelled per-user read state — a row per notice opened *and* a per-viewer watermark,
 * because only a watermark can answer for notices the reader was never shown — and then nothing
 * stored one. Both tables have sat in the catalog unwritten since, which is the shape that produced
 * ADR-0300's `meta.feature_flags` and ADR-0318's `meta.tenant_tombstones`: a table nobody writes
 * drifts behind its contract and nobody finds out. This one had, and in the field that matters —
 * `dispatch_id` was `UUID` against a contract whose `dispatchId` is `disp_…`, so the first `INSERT`
 * would have failed on a schema that read as correct.
 *
 * Two write rules, each enforced **in SQL** rather than by reading first and deciding in process,
 * because an inbox is the one surface where the same person has several tabs open:
 *
 *  - **First read wins.** `ON CONFLICT … DO NOTHING` on `(tenant, user, dispatch)`, so re-opening a
 *    notice cannot move `read_at`. `markRead`'s own comment is the reason: the field answers "when
 *    did you first see this", and an access review relies on that rather than on "when did you last
 *    look". A read-then-insert would let two tabs race and the later one win.
 *  - **A watermark only ever advances.** `GREATEST` inside the `DO UPDATE`, so a stale client
 *    replaying an older position cannot un-read everything between the two. The pure
 *    `markAllReadUpTo` compares against an `existing` the caller loaded, which is exactly the
 *    read-then-write window ADR-0321 closed for deletion requests by re-asserting the premise
 *    inside the `UPDATE`. Same move, same reason: the row is the lock.
 *
 * Both are the third layer for rules the contract and the pure functions already state — the habit
 * ADR-0313 named, where the only way a rule stays true is if it also holds where the write lands.
 */

export interface ReadStateStoreOptions {
  readonly schema?: string;
}

export const READ_STATE_WRITE_OUTCOMES = [
  "inserted",
  /** Already read. The stored row is returned, so `readAt` is the *first* read and not this one. */
  "already_read",
] as const;
export type ReadStateWriteOutcome = (typeof READ_STATE_WRITE_OUTCOMES)[number];

export interface ReadStateWriteResult {
  readonly state: NotificationReadState;
  readonly outcome: ReadStateWriteOutcome;
}

export const WATERMARK_WRITE_OUTCOMES = [
  "advanced",
  /** The stored watermark was already at or past the requested position; nothing moved. */
  "unchanged",
] as const;
export type WatermarkWriteOutcome = (typeof WATERMARK_WRITE_OUTCOMES)[number];

export interface WatermarkWriteResult {
  readonly watermark: NotificationReadWatermark;
  readonly outcome: WatermarkWriteOutcome;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class PostgresReadStateStore {
  private readonly states: string;
  private readonly watermarks: string;
  /** The watermark table's bare name, which is how `ON CONFLICT DO UPDATE` addresses the target. */
  private readonly table = "notification_read_watermarks";

  constructor(
    private readonly conn: PgConnection,
    options: ReadStateStoreOptions = {},
  ) {
    const schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.states = `"${schema}"."notification_read_states"`;
    this.watermarks = `"${schema}"."notification_read_watermarks"`;
  }

  /**
   * Records that a viewer opened one notice.
   *
   * `id` is the caller's — the route mints it, so the store does not need an id generator and a
   * retry of the same request presents the same row. It is only used on the insert; on a conflict
   * the **stored** row is returned, which is why the result carries a `state` rather than echoing
   * the input back.
   */
  async markRead(
    viewer: InboxViewer,
    dispatchId: string,
    input: { readonly id: string; readonly at: string; readonly source: ReadStateSource },
  ): Promise<ReadStateWriteResult> {
    this.assertViewer(viewer);
    return withTenantContext(this.conn, viewer.tenantId, async (tx) => {
      // One statement, not an insert then a select: `RETURNING` on the insert path and the CTE's
      // fallback on the conflict path mean the row that comes back is the row that now holds this
      // (tenant, user, dispatch), whichever of the two happened.
      const result = await tx.query<Record<string, unknown>>(
        `WITH inserted AS (
           INSERT INTO ${this.states}
             (read_state_id, tenant_id, user_id, dispatch_id, read_at, source)
           VALUES ($1, $2::uuid, $3::uuid, $4, $5::timestamptz, $6)
           ON CONFLICT (tenant_id, user_id, dispatch_id) DO NOTHING
           RETURNING read_state_id, tenant_id, user_id, dispatch_id, read_at, source, true AS fresh
         )
         SELECT * FROM inserted
         UNION ALL
         SELECT read_state_id, tenant_id, user_id, dispatch_id, read_at, source, false AS fresh
           FROM ${this.states}
          WHERE tenant_id = $2::uuid AND user_id = $3::uuid AND dispatch_id = $4
            AND NOT EXISTS (SELECT 1 FROM inserted)`,
        [input.id, viewer.tenantId, viewer.userId, dispatchId, input.at, input.source],
      );
      const row = result.rows[0];
      if (row === undefined) {
        // Neither branch produced a row, which under RLS means the insert was confined and the
        // select could not see what it wrote. Throwing beats returning a fabricated receipt: a
        // caller told "read" about a row that does not exist would stop asking.
        throw new Error("read state write produced no row; check the tenant context");
      }
      return {
        state: rowToReadState(row),
        outcome: row["fresh"] === true ? "inserted" : "already_read",
      };
    });
  }

  /**
   * Advances the viewer's watermark, never retreating it.
   *
   * `readThroughAt` is clamped by the caller to its own clock before it gets here — a watermark past
   * `updated_at` is refused by the contract *and* by a table CHECK — and `GREATEST` is what makes
   * the advance safe against a concurrent writer rather than against a value this process read a
   * moment ago.
   */
  async markAllReadUpTo(
    viewer: InboxViewer,
    input: {
      readonly readThroughAt: string;
      readonly at: string;
      readonly source: ReadStateSource;
    },
  ): Promise<WatermarkWriteResult> {
    this.assertViewer(viewer);
    return withTenantContext(this.conn, viewer.tenantId, async (tx) => {
      // `GREATEST` against the stored value, so two tabs cannot race the position backwards. The
      // existing row is addressed by the bare table name: `EXCLUDED` is the proposed row and the
      // target is referenced unqualified inside `DO UPDATE`, which is why this interpolates the
      // table name separately from the schema-qualified one used everywhere else.
      //
      // `source` is overwritten on every write, including one that moves nothing. It describes the
      // last *write* rather than the last *move*, and the pair (source, updated_at) is consistent
      // under that reading — keeping a stale source from an older advance beside a fresh
      // `updated_at` would be the inconsistent choice.
      const result = await tx.query<Record<string, unknown>>(
        `INSERT INTO ${this.watermarks}
           (tenant_id, user_id, read_through_at, updated_at, source)
         VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, $5)
         ON CONFLICT (tenant_id, user_id) DO UPDATE
           SET read_through_at =
                 GREATEST(${this.table}.read_through_at, EXCLUDED.read_through_at),
               updated_at = EXCLUDED.updated_at,
               source = EXCLUDED.source
         RETURNING tenant_id, user_id, read_through_at, updated_at, source`,
        [viewer.tenantId, viewer.userId, input.readThroughAt, input.at, input.source],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("watermark write produced no row; check the tenant context");
      }
      const watermark = rowToWatermark(row);
      // Derived from what came back rather than from SQL: `EXCLUDED` is not in scope in
      // `RETURNING`, so the comparison belongs here. "Advanced" means the stored position is the
      // one that was asked for — `GREATEST` keeping an older row's value is the `unchanged` case.
      return {
        watermark,
        outcome:
          Date.parse(watermark.readThroughAt) === Date.parse(input.readThroughAt)
            ? "advanced"
            : "unchanged",
      };
    });
  }

  /**
   * Everything needed to answer "is this unread" for one viewer, in two queries.
   *
   * Both halves are required and neither substitutes for the other: the rows answer for notices the
   * reader actually opened, and the watermark answers for the ones they were never shown, which is
   * the whole reason ADR-0309 stored two things instead of one.
   */
  async indexFor(viewer: InboxViewer): Promise<ReadStateIndex> {
    this.assertViewer(viewer);
    return withTenantContext(this.conn, viewer.tenantId, async (tx) => {
      const states = await tx.query<Record<string, unknown>>(
        `SELECT read_state_id, tenant_id, user_id, dispatch_id, read_at, source
           FROM ${this.states}
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
        [viewer.tenantId, viewer.userId],
      );
      const watermark = await tx.query<Record<string, unknown>>(
        `SELECT tenant_id, user_id, read_through_at, updated_at, source
           FROM ${this.watermarks}
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
        [viewer.tenantId, viewer.userId],
      );
      // Built by the contract's own `indexReadState`, not assembled here. It checks *both* halves
      // of the key — a row carrying this user id under another tenant must never mark this tenant's
      // notice read, since the same user id can exist in two tenants — and a second
      // implementation of that rule in a store is how the two come to disagree.
      return indexReadState(
        viewer,
        // Re-parsed through the contract on the way out (ADR-0289): a row edited into a state the
        // contract forbids but a CHECK permits is a finding, and here it would silently mark a
        // notice read. Throwing is right — an inbox that fails loudly beats one that hides a notice.
        states.rows.map((r) => rowToReadState(r)),
        watermark.rows.map((r) => rowToWatermark(r)),
      );
    });
  }

  private assertViewer(viewer: InboxViewer): void {
    // Both ids reach a `::uuid` cast and an RLS predicate. Refusing here names which one is wrong;
    // letting Postgres refuse would surface as a 500 with a cast error and no field named.
    if (!UUID_RE.test(viewer.tenantId)) {
      throw new Error(`tenantId must be a uuid, got ${JSON.stringify(viewer.tenantId)}`);
    }
    if (!UUID_RE.test(viewer.userId)) {
      throw new Error(`userId must be a uuid, got ${JSON.stringify(viewer.userId)}`);
    }
  }
}

function rowToReadState(row: Record<string, unknown>): NotificationReadState {
  return NotificationReadStateSchema.parse({
    id: String(row["read_state_id"]),
    tenantId: String(row["tenant_id"]),
    userId: String(row["user_id"]),
    dispatchId: String(row["dispatch_id"]),
    readAt: isoOf(row["read_at"]),
    source: String(row["source"]),
  });
}

function rowToWatermark(row: Record<string, unknown>): NotificationReadWatermark {
  return NotificationReadWatermarkSchema.parse({
    tenantId: String(row["tenant_id"]),
    userId: String(row["user_id"]),
    readThroughAt: isoOf(row["read_through_at"]),
    updatedAt: isoOf(row["updated_at"]),
    source: String(row["source"]),
  });
}

/** node-postgres returns a `Date` for `timestamptz`; the contract wants an offset ISO string. */
function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
