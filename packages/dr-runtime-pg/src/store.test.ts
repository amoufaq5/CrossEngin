import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { PostgresDrillStore } from "./drill-store.js";
import { PostgresFailoverStore } from "./failover-store.js";
import { drillInsertParams, failoverInsertParams, rowToDrillRecord, rowToFailoverRecord } from "./records.js";

const FO_ID = "00000000-0000-4000-8000-0000000000f1";
const DR_ID = "00000000-0000-4000-8000-0000000000d1";

function failoverRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FO_ID,
    tier: "tier_1_business_critical",
    trigger: "planned_drill",
    triggered_by: "ops",
    triggered_at: new Date("2026-06-13T00:00:00.000Z"),
    from_region: "us-east",
    to_region: "us-west",
    affected_apps: JSON.stringify(["operate-server"]),
    status: "queued",
    started_at: null,
    completed_at: null,
    duration_seconds: null,
    actual_rpo_seconds: null,
    actual_rto_seconds: null,
    reverted_at: null,
    reverted_to_failover_id: null,
    incident_ticket_id: null,
    notes: null,
    ...over,
  };
}

function drillRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DR_ID,
    kind: "failover_test",
    tier: "tier_1_business_critical",
    scheduled_for: new Date("2026-06-01T00:00:00.000Z"),
    executed_at: new Date("2026-06-01T00:30:00.000Z"),
    executed_by: "ops",
    scope_regions: ["us-east", "us-west"],
    scope_apps: ["operate-server"],
    outcome: "passed",
    measured_rpo_seconds: "30",
    measured_rto_seconds: "300",
    findings: [],
    report_url: null,
    next_drill_due_at: new Date("2026-07-01T00:00:00.000Z"),
    ...over,
  };
}

function fakeConn(rows: Record<string, unknown>[] = []): { conn: PgConnection; calls: Array<{ sql: string; params: readonly unknown[] }> } {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const conn = {
    async query<T>(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult<T>> {
      calls.push({ sql, params });
      return { rows: rows as readonly T[], rowCount: rows.length };
    },
    async transaction() { throw new Error("unused"); },
    async withAdvisoryLock() { throw new Error("unused"); },
    async close() {},
  } as unknown as PgConnection;
  return { conn, calls };
}

describe("row mappers", () => {
  it("reconstructs a failover record (JSONB apps, Date timestamps)", () => {
    const rec = rowToFailoverRecord(failoverRow());
    expect(rec).toMatchObject({ id: FO_ID, status: "queued", fromRegion: "us-east", toRegion: "us-west", affectedApps: ["operate-server"] });
    expect(rec.triggeredAt).toBe("2026-06-13T00:00:00.000Z");
  });

  it("reconstructs a drill record (BIGINT strings → numbers)", () => {
    const rec = rowToDrillRecord(drillRow());
    expect(rec).toMatchObject({ id: DR_ID, outcome: "passed", measuredRpoSeconds: 30, measuredRtoSeconds: 300 });
    expect(rec.scopeRegions).toEqual(["us-east", "us-west"]);
  });

  it("projects insert params with JSONB-stringified arrays", () => {
    const fo = failoverInsertParams(rowToFailoverRecord(failoverRow()));
    expect(fo[0]).toBe(FO_ID);
    expect(JSON.parse(fo[7] as string)).toEqual(["operate-server"]);
    const dr = drillInsertParams(rowToDrillRecord(drillRow()));
    expect(JSON.parse(dr[6] as string)).toEqual(["us-east", "us-west"]);
  });
});

describe("PostgresFailoverStore", () => {
  it("record upserts on id", async () => {
    const { conn, calls } = fakeConn();
    await new PostgresFailoverStore(conn).record(rowToFailoverRecord(failoverRow()));
    expect(calls[0]!.sql).toContain("INSERT INTO meta.failover_records");
    expect(calls[0]!.sql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(calls[0]!.sql).toContain("$8::jsonb");
  });

  it("get returns null / the record", async () => {
    expect(await new PostgresFailoverStore(fakeConn().conn).get(FO_ID)).toBeNull();
    expect((await new PostgresFailoverStore(fakeConn([failoverRow()]).conn).get(FO_ID))?.id).toBe(FO_ID);
  });

  it("rejects an invalid schema name", () => {
    expect(() => new PostgresFailoverStore(fakeConn().conn, { schema: "x; drop" })).toThrow(/invalid schema/);
  });
});

describe("PostgresDrillStore", () => {
  it("listOverdue queries next_drill_due_at <= asOf", async () => {
    const { conn, calls } = fakeConn([drillRow({ next_drill_due_at: new Date("2026-06-10T00:00:00.000Z") })]);
    const rows = await new PostgresDrillStore(conn).listOverdue(new Date("2026-06-15T00:00:00.000Z"));
    expect(calls[0]!.sql).toContain("next_drill_due_at <= $1");
    expect(rows).toHaveLength(1);
  });
});
