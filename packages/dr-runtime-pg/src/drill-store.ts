import type { DrillKind, DrillRecord } from "@crossengin/dr";
import type { PgConnection } from "@crossengin/kernel-pg";

import { drillInsertParams, rowToDrillRecord } from "./records.js";

const VALID_SCHEMA = /^[a-z_][a-z0-9_]*$/;

/**
 * Persists DR drill records to the platform-wide `meta.dr_drills` table. Backs the
 * `dr-runtime` drill assessment with durable history + the overdue query a scheduler
 * pages on. Record ids must be UUIDs (the table PK).
 */
export class PostgresDrillStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: { readonly schema?: string } = {}) {
    this.conn = conn;
    this.schema = opts.schema ?? "meta";
    if (!VALID_SCHEMA.test(this.schema)) throw new Error(`invalid schema name: ${this.schema}`);
  }

  /** Upserts a drill record on its id. */
  async record(record: DrillRecord): Promise<void> {
    await this.conn.query(
      `INSERT INTO ${this.schema}.dr_drills
        (id, kind, tier, scheduled_for, executed_at, executed_by, scope_regions, scope_apps, outcome,
         measured_rpo_seconds, measured_rto_seconds, findings, report_url, next_drill_due_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$13,$14)
        ON CONFLICT (id) DO UPDATE SET
          executed_at = EXCLUDED.executed_at,
          executed_by = EXCLUDED.executed_by,
          outcome = EXCLUDED.outcome,
          measured_rpo_seconds = EXCLUDED.measured_rpo_seconds,
          measured_rto_seconds = EXCLUDED.measured_rto_seconds,
          findings = EXCLUDED.findings,
          report_url = EXCLUDED.report_url,
          next_drill_due_at = EXCLUDED.next_drill_due_at`,
      drillInsertParams(record),
    );
  }

  /** Reads one drill record, or `null`. */
  async get(id: string): Promise<DrillRecord | null> {
    const res = await this.conn.query<Record<string, unknown>>(`SELECT * FROM ${this.schema}.dr_drills WHERE id = $1`, [id]);
    const row = res.rows[0];
    return row === undefined ? null : rowToDrillRecord(row);
  }

  /** Drills of a kind, newest-scheduled first. */
  async listForKind(kind: DrillKind, opts: { readonly limit?: number } = {}): Promise<readonly DrillRecord[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const res = await this.conn.query<Record<string, unknown>>(
      `SELECT * FROM ${this.schema}.dr_drills WHERE kind = $1 ORDER BY scheduled_for DESC, id DESC LIMIT $2`,
      [kind, limit],
    );
    return res.rows.map(rowToDrillRecord);
  }

  /** Drills past their next-due date as of `asOf` (the overdue query a scheduler pages on). */
  async listOverdue(asOf: Date): Promise<readonly DrillRecord[]> {
    const res = await this.conn.query<Record<string, unknown>>(
      `SELECT * FROM ${this.schema}.dr_drills WHERE next_drill_due_at <= $1 ORDER BY next_drill_due_at ASC`,
      [asOf.toISOString()],
    );
    return res.rows.map(rowToDrillRecord);
  }
}
