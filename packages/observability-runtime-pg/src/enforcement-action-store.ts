import type { PgConnection } from "@crossengin/kernel-pg";
import {
  scopedRead,
  scopedWrite,
  scopeFilter,
  SloEnforcementActionRecordSchema,
  type SloEnforcementActionRecord,
} from "./records.js";

const SCHEMA = "meta";
const TABLE = "slo_enforcement_actions";

interface ColumnBinding {
  readonly column: string;
  readonly bind: (record: SloEnforcementActionRecord) => unknown;
}

/**
 * One list drives the column order, the placeholder count and the bound values. They used to be two
 * lists held in agreement by hand, so a column added to one and not the other bound the wrong value
 * to every column after it.
 */
const COLUMN_BINDINGS: readonly ColumnBinding[] = [
  { column: "action_id", bind: (r) => r.actionId },
  { column: "tenant_id", bind: (r) => r.tenantId },
  { column: "slo_id", bind: (r) => r.sloId },
  { column: "surface", bind: (r) => r.surface },
  { column: "signal", bind: (r) => r.signal },
  { column: "decision", bind: (r) => r.decision },
  { column: "severity", bind: (r) => r.severity },
  { column: "incident_id", bind: (r) => r.incidentId },
  { column: "kill_switch_id", bind: (r) => r.killSwitchId },
  { column: "flag_id", bind: (r) => r.flagId },
  { column: "paged", bind: (r) => r.paged },
  { column: "page_channel_count", bind: (r) => r.pageChannelCount },
  { column: "threshold_id", bind: (r) => r.thresholdId },
  { column: "close_out", bind: (r) => r.closeOut },
  { column: "occurred_at", bind: (r) => r.occurredAt },
];

/** The stored column order, exported so a caller never has to count placeholders itself. */
export const SLO_ENFORCEMENT_ACTION_COLUMNS: readonly string[] = COLUMN_BINDINGS.map(
  (binding) => binding.column,
);

const COLUMN_LIST = SLO_ENFORCEMENT_ACTION_COLUMNS.join(", ");
const PLACEHOLDER_LIST = COLUMN_BINDINGS.map((_, index) => `$${index + 1}`).join(", ");

export class PostgresSloEnforcementActionStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async record(record: SloEnforcementActionRecord): Promise<void> {
    const valid = SloEnforcementActionRecordSchema.parse(record);
    await scopedWrite(this.conn, valid.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (${COLUMN_LIST})
         VALUES (${PLACEHOLDER_LIST})
         ON CONFLICT (action_id) DO NOTHING`,
        COLUMN_BINDINGS.map((binding) => binding.bind(valid)),
    
      ),
    );
  }

  /**
   * One scope's enforcement history for an incident, oldest first.
   *
   * An incident id is not a scope either. `SloEnforcementReplayer.verifyIncident` checks this list
   * for a duplicate open and a page with no channels, so another scope's actions on the same id do
   * not merely lengthen the list — they *invent drift*. Observed live as the owner: one platform
   * `breach_opened` and one tenant `breach_opened` on `INC-2026-0001` read as a duplicate open.
   */
  async listForIncident(
    incidentId: string,
    tenantId: string | null = null,
  ): Promise<readonly SloEnforcementActionRecord[]> {
    const scope = scopeFilter(tenantId, 2);
    const result = await scopedRead(this.conn, tenantId, (tx) =>
      tx.query<Record<string, unknown>>(
        `SELECT ${COLUMN_LIST}
         FROM ${SCHEMA}.${TABLE}
         WHERE incident_id = $1 AND ${scope.sql}
         ORDER BY occurred_at ASC`,
        [incidentId, ...scope.params],
      ),
    );
    return result.rows.map((row) => rowToRecord(row));
  }

  /**
   * The newest actions in one scope.
   *
   * A `LIMIT` over an unscoped read is the costly half: another scope's rows displace the asked-for
   * ones rather than joining them. Observed live as the owner with two newer tenant rows beside one
   * platform row, `listRecent(2)` returned both tenant rows and none of the platform's, so
   * `summarizeRecent`'s `pagedRatio` came back 0 for a page that had in fact paged.
   */
  async listRecent(
    limit = 100,
    tenantId: string | null = null,
  ): Promise<readonly SloEnforcementActionRecord[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const scope = scopeFilter(tenantId, 1);
    const result = await scopedRead(this.conn, tenantId, (tx) =>
      tx.query<Record<string, unknown>>(
        `SELECT ${COLUMN_LIST}
         FROM ${SCHEMA}.${TABLE}
         WHERE ${scope.sql}
         ORDER BY occurred_at DESC
         LIMIT $${String(1 + scope.params.length)}`,
        [...scope.params, limit],
      ),
    );
    return result.rows.map((row) => rowToRecord(row));
  }

  async countSince(since: Date, tenantId: string | null = null): Promise<number> {
    const scope = scopeFilter(tenantId, 2);
    const result = await scopedRead(this.conn, tenantId, (tx) =>
      tx.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count FROM ${SCHEMA}.${TABLE}
         WHERE occurred_at >= $1 AND ${scope.sql}`,
        [since.toISOString(), ...scope.params],
      ),
    );
    const row = result.rows[0];
    if (row === undefined) return 0;
    return Number.parseInt(row.count, 10);
  }
}

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function rowToRecord(row: Record<string, unknown>): SloEnforcementActionRecord {
  const occurredAt = row["occurred_at"];
  return SloEnforcementActionRecordSchema.parse({
    actionId: asString(row["action_id"]),
    tenantId: asNullableString(row["tenant_id"]),
    sloId: asString(row["slo_id"]),
    surface: asString(row["surface"]),
    signal: asString(row["signal"]),
    decision: asString(row["decision"]),
    severity: asNullableString(row["severity"]),
    incidentId: asString(row["incident_id"]),
    killSwitchId: asNullableString(row["kill_switch_id"]),
    flagId: asNullableString(row["flag_id"]),
    paged: row["paged"] === true,
    pageChannelCount: Number(row["page_channel_count"] ?? 0),
    thresholdId: asNullableString(row["threshold_id"]),
    closeOut: asNullableString(row["close_out"]),
    occurredAt:
      occurredAt instanceof Date ? occurredAt.toISOString() : asString(occurredAt),
  });
}
