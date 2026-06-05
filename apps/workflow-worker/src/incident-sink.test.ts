import type { IncidentRecord } from "@crossengin/incident-response";
import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresIncidentSink } from "./incident-sink.js";

function capture(): { conn: PgConnection; last: { sql: string; params: readonly unknown[] } } {
  const last = { sql: "", params: [] as readonly unknown[] };
  const query = (async (sql: string, params?: readonly unknown[]) => {
    last.sql = sql;
    last.params = params ?? [];
    return { rows: [], rowCount: 1 };
  }) as PgConnection["query"];
  return { conn: { query, transaction: vi.fn() as PgConnection["transaction"], withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"], close: vi.fn() as PgConnection["close"] }, last };
}

const INCIDENT: IncidentRecord = {
  id: "INC-2026-0001",
  title: "2 workflow worker(s) stale",
  severity: "sev2",
  category: "availability",
  status: "declared",
  affectedTenantIds: [],
  affectedRegions: [],
  publiclyVisible: false,
  declaredAt: "2026-06-04T12:00:00.000Z",
  declaredBy: "00000000-0000-4000-8000-000000000000",
  roleAssignments: [],
  timeline: [{ occurredAt: "2026-06-04T12:00:00.000Z", actorUserId: "00000000-0000-4000-8000-000000000000", kind: "declared", message: "stale", metadata: {} }],
  securityIncident: false,
  breachDataClasses: [],
} as unknown as IncidentRecord;

describe("PostgresIncidentSink.record", () => {
  it("inserts the incident keyed on incident_id with ON CONFLICT DO NOTHING", async () => {
    const cap = capture();
    await new PostgresIncidentSink(cap.conn).record(INCIDENT);
    expect(cap.last.sql).toContain("INSERT INTO meta.incidents");
    expect(cap.last.sql).toContain("ON CONFLICT (incident_id) DO NOTHING");
    expect(cap.last.sql).toContain("$9::jsonb");
    expect(cap.last.params?.slice(0, 5)).toEqual(["INC-2026-0001", "2 workflow worker(s) stale", "sev2", "availability", "declared"]);
    expect(cap.last.params?.[7]).toBe("00000000-0000-4000-8000-000000000000"); // declared_by
    expect(JSON.parse(cap.last.params?.[8] as string)).toHaveLength(1); // timeline
  });

  it("honors a custom schema and rejects an invalid one", async () => {
    const cap = capture();
    await new PostgresIncidentSink(cap.conn, { schema: "ops" }).record(INCIDENT);
    expect(cap.last.sql).toContain("ops.incidents");
    expect(() => new PostgresIncidentSink(cap.conn, { schema: "x; DROP" })).toThrow(/invalid schema/);
  });

  it("resolve transitions an open incident to resolved and appends a timeline entry", async () => {
    const cap = capture();
    await new PostgresIncidentSink(cap.conn).resolve("INC-2026-0001", "00000000-0000-4000-8000-000000000001");
    expect(cap.last.sql).toContain("UPDATE meta.incidents");
    expect(cap.last.sql).toContain("SET status = 'resolved', resolved_at = now(), timeline = timeline || $2::jsonb");
    expect(cap.last.sql).toContain("WHERE incident_id = $1 AND status <> 'resolved'");
    expect(cap.last.params?.[0]).toBe("INC-2026-0001");
    const entries = JSON.parse(cap.last.params?.[1] as string) as ReadonlyArray<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("resolved");
    expect(entries[0]?.actorUserId).toBe("00000000-0000-4000-8000-000000000001");
    expect(typeof entries[0]?.occurredAt).toBe("string");
  });

  it("acknowledge transitions declared → triaged, stamps acked_at, appends a status_changed entry", async () => {
    const cap = capture();
    await new PostgresIncidentSink(cap.conn).acknowledge("INC-2026-0001", "00000000-0000-4000-8000-000000000001");
    expect(cap.last.sql).toContain("UPDATE meta.incidents");
    expect(cap.last.sql).toContain("SET status = 'triaged', acked_at = COALESCE(acked_at, now()), timeline = timeline || $2::jsonb");
    expect(cap.last.sql).toContain("WHERE incident_id = $1 AND status = 'declared'");
    const entries = JSON.parse(cap.last.params?.[1] as string) as ReadonlyArray<Record<string, unknown>>;
    expect(entries[0]?.kind).toBe("status_changed");
    expect(entries[0]?.metadata).toEqual({ status: "triaged" });
  });

  it("mitigate transitions a pre-mitigated incident → mitigated, stamps mitigated_at, appends a status_changed entry", async () => {
    const cap = capture();
    await new PostgresIncidentSink(cap.conn).mitigate("INC-2026-0001", "00000000-0000-4000-8000-000000000001");
    expect(cap.last.sql).toContain("SET status = 'mitigated', mitigated_at = COALESCE(mitigated_at, now()), timeline = timeline || $2::jsonb");
    expect(cap.last.sql).toContain("WHERE incident_id = $1 AND status IN ('declared', 'triaged', 'mitigating')");
    const entries = JSON.parse(cap.last.params?.[1] as string) as ReadonlyArray<Record<string, unknown>>;
    expect(entries[0]?.kind).toBe("status_changed");
    expect(entries[0]?.metadata).toEqual({ status: "mitigated" });
  });

  it("escalate raises the severity of an open incident and appends a timeline entry", async () => {
    const cap = capture();
    await new PostgresIncidentSink(cap.conn).escalate("INC-2026-0001", "sev2", "00000000-0000-4000-8000-000000000001");
    expect(cap.last.sql).toContain("UPDATE meta.incidents");
    expect(cap.last.sql).toContain("SET severity = $2, timeline = timeline || $3::jsonb");
    expect(cap.last.sql).toContain("WHERE incident_id = $1 AND status <> 'resolved'");
    expect(cap.last.params?.slice(0, 2)).toEqual(["INC-2026-0001", "sev2"]);
    const entries = JSON.parse(cap.last.params?.[2] as string) as ReadonlyArray<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("severity_changed");
    expect(entries[0]?.metadata).toEqual({ severity: "sev2" });
    expect(entries[0]?.actorUserId).toBe("00000000-0000-4000-8000-000000000001");
  });
});
