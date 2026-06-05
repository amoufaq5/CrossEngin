import type { IncidentRecord, Severity } from "@crossengin/incident-response";
import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Persists a declared `IncidentRecord` to `meta.incidents` — the real sink for
 * the stale-worker monitor's `onIncident` (the alternative to just logging). The
 * INSERT is keyed on `incident_id` with `ON CONFLICT DO NOTHING`, so a re-declare
 * of the same incident id (the monitor's per-check dedup) is idempotent. The
 * connecting role must be able to write `meta.incidents`, and `declared_by` must
 * reference an existing `meta.users` row (a system actor).
 */
export class PostgresIncidentSink {
  private readonly conn: PgConnection;
  private readonly table: string;

  constructor(conn: PgConnection, opts: { readonly schema?: string } = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    this.table = `${schema}.incidents`;
  }

  async record(incident: IncidentRecord): Promise<void> {
    await this.conn.query(
      `INSERT INTO ${this.table} (
         incident_id, title, severity, category, status,
         affected_tenant_ids, declared_at, declared_by, timeline
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb)
       ON CONFLICT (incident_id) DO NOTHING`,
      [
        incident.id,
        incident.title,
        incident.severity,
        incident.category,
        incident.status,
        JSON.stringify(incident.affectedTenantIds),
        incident.declaredAt,
        incident.declaredBy,
        JSON.stringify(incident.timeline),
      ],
    );
  }

  /**
   * Transitions an open incident to `resolved` (stamping `resolved_at`) and
   * appends a `resolved` timeline entry — the recovery side of the loop, called
   * when the workers that triggered it start beating again. Idempotent: a no-op
   * if the incident is absent or already resolved.
   */
  async resolve(incidentId: string, actorUserId: string): Promise<void> {
    const entry = this.timelineEntry(actorUserId, "resolved", "stale workers recovered", {});
    await this.conn.query(
      `UPDATE ${this.table}
          SET status = 'resolved', resolved_at = now(), timeline = timeline || $2::jsonb
        WHERE incident_id = $1 AND status <> 'resolved'`,
      [incidentId, JSON.stringify([entry])],
    );
  }

  /**
   * Raises an open incident's severity (when more workers go stale mid-incident)
   * and appends a `severity_changed` timeline entry. A no-op for a resolved
   * incident; the monitor only ever escalates (raises), never lowers.
   */
  async escalate(incidentId: string, severity: Severity, actorUserId: string): Promise<void> {
    const entry = this.timelineEntry(actorUserId, "severity_changed", `severity raised to ${severity}`, { severity });
    await this.conn.query(
      `UPDATE ${this.table}
          SET severity = $2, timeline = timeline || $3::jsonb
        WHERE incident_id = $1 AND status <> 'resolved'`,
      [incidentId, severity, JSON.stringify([entry])],
    );
  }

  private timelineEntry(actorUserId: string, kind: string, message: string, metadata: Record<string, unknown>): Record<string, unknown> {
    return { occurredAt: new Date().toISOString(), actorUserId, kind, message, metadata };
  }
}
