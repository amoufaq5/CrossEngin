import type { PgConnection } from "@crossengin/kernel-pg";
import { formatIncidentId, type IncidentRecord } from "@crossengin/incident-response";

import {
  INCIDENT_COLUMNS,
  INCIDENT_COLUMN_NAMES,
  incidentPlaceholders,
  incidentRowValues,
  incidentUpdateAssignments,
  rowToIncident,
  type StoredIncident,
} from "./records.js";

const SCHEMA = "meta";
const TABLE = "incidents";

/** Serializes id allocation so two declarers cannot compute the same next sequence. */
const INCIDENT_SEQUENCE_LOCK = 8_675_311n;

export class IncidentRevisionConflictError extends Error {
  constructor(
    readonly incidentId: string,
    readonly expectedRevision: number,
  ) {
    super(
      `incident '${incidentId}' was not at revision ${expectedRevision} — ` +
        "another writer changed it first",
    );
    this.name = "IncidentRevisionConflictError";
  }
}

export class IncidentNotFoundError extends Error {
  constructor(readonly incidentId: string) {
    super(`incident '${incidentId}' not found`);
    this.name = "IncidentNotFoundError";
  }
}

const PLACEHOLDERS = incidentPlaceholders();
const UPDATE_ASSIGNMENTS = incidentUpdateAssignments();
/** The revision guard binds after every column value, so it is always the next placeholder. */
const REVISION_GUARD_PARAM = INCIDENT_COLUMN_NAMES.length + 1;

/**
 * Persists declared incidents in `meta.incidents`.
 *
 * Platform-wide, so there is no `withTenantContext` wrapper and no RLS to set up: an incident may
 * name many tenants or none, and confining it to one would hide exactly the cross-tenant events
 * incidents exist to describe. Reads are therefore unfiltered by design, which is why nothing
 * tenant-facing is wired to this store.
 */
export class PostgresIncidentStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  /**
   * Reserves the next incident id for a year from the rows that exist, not from a counter in this
   * process. The advisory lock makes concurrent allocation safe, and `incidents_year_sequence_key`
   * is what makes a collision impossible even if two processes bypassed the lock.
   */
  async allocateIncidentId(year: number): Promise<string> {
    return this.conn.withAdvisoryLock(INCIDENT_SEQUENCE_LOCK, async () => {
      const result = await this.conn.query<{ next: string }>(
        `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next
         FROM ${SCHEMA}.${TABLE}
         WHERE year = $1`,
        [year],
      );
      const row = result.rows[0];
      const next = row === undefined ? 1 : Number.parseInt(row.next, 10);
      return formatIncidentId(year, next);
    });
  }

  async insert(record: IncidentRecord, at: string): Promise<StoredIncident> {
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (${INCIDENT_COLUMNS}) VALUES (${PLACEHOLDERS})`,
      incidentRowValues(record, 1, at),
    );
    return { record, revision: 1, updatedAt: at };
  }

  /**
   * Writes a new version of an incident, but only if it is still at the revision the caller read.
   * A zero-row update is a conflict, not a success — the alternative is silently discarding
   * whatever the other writer did.
   */
  async update(
    record: IncidentRecord,
    expectedRevision: number,
    at: string,
  ): Promise<StoredIncident> {
    const nextRevision = expectedRevision + 1;
    const values = incidentRowValues(record, nextRevision, at);
    const result = await this.conn.query(
      `UPDATE ${SCHEMA}.${TABLE} SET ${UPDATE_ASSIGNMENTS}
       WHERE incident_id = $1 AND revision = $${REVISION_GUARD_PARAM}`,
      [...values, expectedRevision],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new IncidentRevisionConflictError(record.id, expectedRevision);
    }
    return { record, revision: nextRevision, updatedAt: at };
  }

  async load(incidentId: string): Promise<StoredIncident | null> {
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${INCIDENT_COLUMNS} FROM ${SCHEMA}.${TABLE} WHERE incident_id = $1`,
      [incidentId],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToIncident(row);
  }

  async listOpen(limit = 100): Promise<readonly StoredIncident[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${INCIDENT_COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE status NOT IN ('closed', 'cancelled')
       ORDER BY declared_at ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => rowToIncident(row));
  }

  async listForTenant(tenantId: string, limit = 100): Promise<readonly StoredIncident[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${INCIDENT_COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE affected_tenant_ids @> to_jsonb($1::text)
       ORDER BY declared_at DESC
       LIMIT $2`,
      [tenantId, limit],
    );
    return result.rows.map((row) => rowToIncident(row));
  }

  async listRecent(limit = 100): Promise<readonly StoredIncident[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${INCIDENT_COLUMNS} FROM ${SCHEMA}.${TABLE}
       ORDER BY declared_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => rowToIncident(row));
  }

  async countSince(since: Date): Promise<number> {
    const result = await this.conn.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM ${SCHEMA}.${TABLE} WHERE declared_at >= $1`,
      [since.toISOString()],
    );
    const row = result.rows[0];
    if (row === undefined) return 0;
    return Number.parseInt(row.count, 10);
  }
}
