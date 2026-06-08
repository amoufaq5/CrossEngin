import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import type { IncidentMetrics } from "./metrics.js";
import {
  PostgresIncidentMetricsStore,
  generateSnapshotId,
  incidentMetricsSnapshotRow,
} from "./metrics-store.js";

interface Call {
  sql: string;
  params: readonly unknown[];
}

function capture(rows: readonly Record<string, unknown>[] = []): {
  conn: PgConnection;
  calls: Call[];
} {
  const calls: Call[] = [];
  const query = (async (sql: string, params?: readonly unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    return { rows, rowCount: rows.length } as PgQueryResult;
  }) as PgConnection["query"];
  return {
    conn: {
      query,
      transaction: vi.fn() as PgConnection["transaction"],
      withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
      close: vi.fn() as PgConnection["close"],
    },
    calls,
  };
}

const METRICS: IncidentMetrics = {
  total: 5,
  open: 2,
  resolved: 3,
  bySeverity: { sev1: 0, sev2: 3, sev3: 2, sev4: 0, sev5: 0 },
  openBySeverity: { sev1: 0, sev2: 1, sev3: 1, sev4: 0, sev5: 0 },
  escalations: 1,
  mttp: { count: 3, meanMs: 1000, p50Ms: 1000, p95Ms: 1200, maxMs: 1500 },
  mtta: { count: 3, meanMs: 2000, p50Ms: 2000, p95Ms: 2200, maxMs: 2500 },
  mttm: null,
  mttr: { count: 3, meanMs: 5000, p50Ms: 5000, p95Ms: 6000, maxMs: 7000 },
};

const WINDOW = { from: "2026-06-01T00:00:00.000Z", to: "2026-06-08T00:00:00.000Z" };

describe("generateSnapshotId", () => {
  it("mints an ims_-prefixed id matching the table check regex", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(generateSnapshotId()).toMatch(/^ims_[a-z0-9]{8,40}$/);
    }
  });
});

describe("incidentMetricsSnapshotRow", () => {
  it("projects window + metrics, minting an id when none supplied", () => {
    const row = incidentMetricsSnapshotRow(WINDOW, METRICS);
    expect(row.snapshotId).toMatch(/^ims_/);
    expect(row.windowFrom).toBe(WINDOW.from);
    expect(row.windowTo).toBe(WINDOW.to);
    expect(row.total).toBe(5);
    expect(row.open).toBe(2);
    expect(row.resolved).toBe(3);
    expect(row.escalations).toBe(1);
    expect(row.bySeverity).toEqual(METRICS.bySeverity);
    expect(row.mttm).toBeNull();
    expect(row.mttr).toEqual(METRICS.mttr);
  });

  it("honors a supplied snapshotId and Date windows", () => {
    const row = incidentMetricsSnapshotRow(
      { from: new Date("2026-06-01T00:00:00.000Z"), to: new Date("2026-06-08T00:00:00.000Z") },
      METRICS,
      { snapshotId: "ims_fixed01" },
    );
    expect(row.snapshotId).toBe("ims_fixed01");
    expect(row.windowFrom).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("PostgresIncidentMetricsStore.recordSnapshot", () => {
  it("INSERTs the snapshot row with JSONB-cast stat columns", async () => {
    const cap = capture();
    const row = await new PostgresIncidentMetricsStore(cap.conn).recordSnapshot(WINDOW, METRICS, {
      snapshotId: "ims_test0001",
    });
    expect(cap.calls).toHaveLength(1);
    const call = cap.calls[0];
    expect(call.sql).toContain("INSERT INTO meta.incident_metric_snapshots");
    expect(call.sql).toContain("$8::jsonb");
    expect(call.sql).toContain("$13::jsonb");
    expect(call.params[0]).toBe("ims_test0001");
    expect(call.params.slice(1, 7)).toEqual([WINDOW.from, WINDOW.to, 5, 2, 3, 1]);
    // by_severity / open_by_severity serialized as JSON strings
    expect(JSON.parse(call.params[7] as string)).toEqual(METRICS.bySeverity);
    expect(JSON.parse(call.params[8] as string)).toEqual(METRICS.openBySeverity);
    // mttm is null → bound as null, not the string "null"
    expect(call.params[11]).toBeNull();
    expect(JSON.parse(call.params[12] as string)).toEqual(METRICS.mttr);
    expect(row.snapshotId).toBe("ims_test0001");
  });

  it("honors a custom schema and rejects an invalid one", async () => {
    const cap = capture();
    await new PostgresIncidentMetricsStore(cap.conn, { schema: "ops" }).recordSnapshot(WINDOW, METRICS);
    expect(cap.calls[0].sql).toContain("ops.incident_metric_snapshots");
    expect(() => new PostgresIncidentMetricsStore(cap.conn, { schema: "x; DROP" })).toThrow(/invalid schema/);
  });
});

describe("PostgresIncidentMetricsStore.listSnapshots", () => {
  it("reads a window newest-first with a clamped limit", async () => {
    const dbRow = {
      snapshot_id: "ims_test0001",
      window_from: "2026-06-01T00:00:00.000Z",
      window_to: "2026-06-08T00:00:00.000Z",
      computed_at: "2026-06-08T01:00:00.000Z",
      total: 5,
      open: 2,
      resolved: 3,
      escalations: 1,
      by_severity: METRICS.bySeverity,
      open_by_severity: METRICS.openBySeverity,
      mttp: METRICS.mttp,
      mtta: METRICS.mtta,
      mttm: null,
      mttr: METRICS.mttr,
    };
    const cap = capture([dbRow]);
    const out = await new PostgresIncidentMetricsStore(cap.conn).listSnapshots({
      from: WINDOW.from,
      to: WINDOW.to,
      limit: 10,
    });
    const call = cap.calls[0];
    expect(call.sql).toContain("FROM meta.incident_metric_snapshots");
    expect(call.sql).toContain("ORDER BY computed_at DESC");
    expect(call.params).toEqual([WINDOW.from, WINDOW.to, 10]);
    expect(out).toHaveLength(1);
    expect(out[0].snapshotId).toBe("ims_test0001");
    expect(out[0].computedAt).toBe("2026-06-08T01:00:00.000Z");
    expect(out[0].total).toBe(5);
    expect(out[0].mttm).toBeNull();
    expect(out[0].mttr).toEqual(METRICS.mttr);
  });

  it("parses string-encoded JSONB and integer columns from the driver", async () => {
    const dbRow = {
      snapshot_id: "ims_test0002",
      window_from: new Date("2026-06-01T00:00:00.000Z"),
      window_to: new Date("2026-06-08T00:00:00.000Z"),
      computed_at: new Date("2026-06-08T01:00:00.000Z"),
      total: "5",
      open: "2",
      resolved: "3",
      escalations: "1",
      by_severity: JSON.stringify(METRICS.bySeverity),
      open_by_severity: JSON.stringify(METRICS.openBySeverity),
      mttp: JSON.stringify(METRICS.mttp),
      mtta: null,
      mttm: null,
      mttr: JSON.stringify(METRICS.mttr),
    };
    const cap = capture([dbRow]);
    const out = await new PostgresIncidentMetricsStore(cap.conn).listSnapshots({ from: WINDOW.from, to: WINDOW.to });
    expect(cap.calls[0].params[2]).toBe(100); // default limit
    expect(out[0].total).toBe(5);
    expect(out[0].windowFrom).toBe("2026-06-01T00:00:00.000Z");
    expect(out[0].bySeverity).toEqual(METRICS.bySeverity);
    expect(out[0].mttp).toEqual(METRICS.mttp);
    expect(out[0].mtta).toBeNull();
  });
});
