import {
  readRows,
  textIdentity,
  type PgConnection,
  type UnreadableRowReporter,
} from "@crossengin/kernel-pg";
import {
  DrReadinessSnapshotRecordSchema,
  scopedWrite,
  type DrReadinessSnapshotRecord,
} from "./records.js";
import { scopeFilter, type DrReadScope } from "./tenant-context.js";

const SCHEMA = "meta";
const TABLE = "dr_readiness_snapshots";

const COLUMNS = `snapshot_id, tenant_id, ready, total_issues, overdue_drills,
  stale_runbooks, expired_backups, unverified_backups, replication_violations,
  failover_breaches, drill_breaches, unevidenced_axes, report, generated_at`;

export class PostgresDrReadinessStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  /**
   * **`DO NOTHING` is correct here and is deliberately not swept with the other two.**
   *
   * The failover and drill stores wrote `DO NOTHING` on an *upsert* path — the executor hands them
   * the same `execution_id` again with a changed state — so every transition after the first was
   * dropped in silence. A readiness snapshot is not that: it is a measurement at a moment, there is
   * no runtime method that takes a report and returns a changed one under the same id, and
   * `readinessSnapshotRecordFrom` mints a fresh `drr_…` per assessment. The only way to reach this
   * conflict at all is for a caller to pass the *same* explicit `snapshotId` twice, which says
   * "write this snapshot once" — exactly the idempotent first write `DO NOTHING` is for. Widening it
   * to a `DO UPDATE` would let a later assessment rewrite an earlier verdict under its id, and a
   * readiness verdict is what a SOC 2 auditor reads.
   *
   * The catalog agrees: `meta.dr_readiness_snapshots` carries three RLS policies, with no `UPDATE`
   * arm, so a platform-scope snapshot is immutable-by-RLS once written.
   */
  async record(record: DrReadinessSnapshotRecord): Promise<void> {
    const valid = DrReadinessSnapshotRecordSchema.parse(record);
    await scopedWrite(this.conn, valid.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
         ON CONFLICT (snapshot_id) DO NOTHING`,
        [
          valid.snapshotId,
          valid.tenantId,
          valid.ready,
          valid.totalIssues,
          valid.overdueDrills,
          valid.staleRunbooks,
          valid.expiredBackups,
          valid.unverifiedBackups,
          valid.replicationViolations,
          valid.failoverBreaches,
          valid.drillBreaches,
          // Bound as the array itself, so node-postgres renders the `TEXT[]` literal: a `null` here
          // is a SQL NULL and an `[]` is an empty array, which is the whole three-valued point one
          // layer down. `JSON.stringify` would make both of them strings a `TEXT[]` column refuses.
          valid.unevidencedAxes,
          JSON.stringify(valid.report),
          valid.generatedAt,
        ],
      ),
    );
  }

  /**
   * **This method has no caller anywhere in the workspace**, and the shape is chosen for the first
   * one rather than read off a consumer that does not exist: a required reporter, matching its two
   * sibling stores, so whoever wires it finds one convention in the package instead of two.
   *
   * It carried the same `.map(rowToRecord)` as its siblings and is swept with them because the
   * defect is in the artifact rather than in a deployment — a reader added later would inherit it,
   * and the row it would lose is a stored readiness verdict, which is what a SOC 2 auditor reads.
   * Nothing here closed a live gap; `latest()` below is the method certification actually calls,
   * and it reads one row, where there is no other row to take down.
   */
  async listRecent(
    scope: DrReadScope,
    onUnreadable: UnreadableRowReporter,
    limit = 100,
  ): Promise<readonly DrReadinessSnapshotRecord[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const filter = scopeFilter(scope);
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE ${filter.sql}
       ORDER BY generated_at DESC
       LIMIT $${String(filter.params.length + 1)}`,
      [...filter.params, limit],
    );
    return readRows(result.rows, rowToRecord, snapshotIdentity, onUnreadable);
  }

  /**
   * The sharpest of the three unscoped reads, because it answers with exactly one row and no
   * caller can tell it chose the wrong one: `ORDER BY generated_at DESC LIMIT 1` with no predicate
   * returned **whichever tenant's snapshot was newest** as the platform's readiness. Observed live.
   */
  async latest(scope: DrReadScope): Promise<DrReadinessSnapshotRecord | null> {
    const filter = scopeFilter(scope);
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE ${filter.sql}
       ORDER BY generated_at DESC
       LIMIT 1`,
      [...filter.params],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToRecord(row);
  }
}

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asInt(value: unknown): number {
  return Number(value ?? 0);
}

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : asString(value);
}

function asReport(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * A SQL NULL maps to `null` and **never** to `[]`.
 *
 * Collapsing them here would undo the distinction the column exists for one layer up: `null` is a
 * row written before this check and `[]` is the claim that every axis carried a record, and reading
 * the first as the second is the falsely-true direction. Everything else is handed to the schema
 * unexamined — `asReport`'s treatment — so an axis this binary does not recognise is refused by
 * `DrEvidenceAxisSchema` rather than coerced here (ADR-0371).
 */
function asAxes(value: unknown): unknown {
  return value === null || value === undefined ? null : value;
}

/** `drillIdentity`'s argument, one table over: the conflict key is the only addressable handle. */
function snapshotIdentity(row: Record<string, unknown>): string | null {
  return textIdentity(row, "snapshot_id");
}

function rowToRecord(
  row: Record<string, unknown>,
): DrReadinessSnapshotRecord {
  return DrReadinessSnapshotRecordSchema.parse({
    snapshotId: asString(row["snapshot_id"]),
    tenantId: asNullableString(row["tenant_id"]),
    ready: row["ready"] === true,
    totalIssues: asInt(row["total_issues"]),
    overdueDrills: asInt(row["overdue_drills"]),
    staleRunbooks: asInt(row["stale_runbooks"]),
    expiredBackups: asInt(row["expired_backups"]),
    unverifiedBackups: asInt(row["unverified_backups"]),
    replicationViolations: asInt(row["replication_violations"]),
    failoverBreaches: asInt(row["failover_breaches"]),
    drillBreaches: asInt(row["drill_breaches"]),
    unevidencedAxes: asAxes(row["unevidenced_axes"]),
    report: asReport(row["report"]),
    generatedAt: asIso(row["generated_at"]),
  });
}
