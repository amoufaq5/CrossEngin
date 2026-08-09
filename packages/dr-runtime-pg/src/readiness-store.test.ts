import { describe, expect, it } from "vitest";
import { assessDrReadiness } from "@crossengin/dr-runtime";
import { PostgresDrReadinessStore } from "./readiness-store.js";
import { readinessSnapshotRecordFrom } from "./records.js";
import { mockConnection, type Captured } from "./test-fakes.js";

const NOW = "2026-06-02T12:00:00.000Z";
const TENANT = "00000000-0000-4000-8000-000000000001";

function record(snapshotId = "drr_snap0001") {
  const report = assessDrReadiness({});
  return readinessSnapshotRecordFrom(report, {
    tenantId: TENANT,
    generatedAt: NOW,
    snapshotId,
  });
}

describe("PostgresDrReadinessStore.record", () => {
  it("issues an INSERT ... ON CONFLICT DO NOTHING with bound params", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrReadinessStore(mockConnection(capture));
    await store.record(record());
    expect(capture[0]?.sql).toContain("INSERT INTO meta.dr_readiness_snapshots");
    expect(capture[0]?.sql).toContain("ON CONFLICT (snapshot_id) DO NOTHING");
    expect(capture[0]?.sql).toContain("$12::jsonb");
    expect(capture[0]?.params?.[0]).toBe("drr_snap0001");
    expect(capture[0]?.params?.[1]).toBe(TENANT);
    expect(capture[0]?.params?.[2]).toBe(true);
    expect(capture[0]?.params?.[3]).toBe(0);
  });

  it("serializes the full report as a json string", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrReadinessStore(mockConnection(capture));
    await store.record(record());
    const raw = capture[0]?.params?.[11];
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw as string).ready).toBe(true);
  });

  it("validates before insert", async () => {
    const store = new PostgresDrReadinessStore(mockConnection());
    const bad = { ...record(), snapshotId: "bad" };
    await expect(store.record(bad)).rejects.toThrow();
  });
});

describe("PostgresDrReadinessStore.listRecent / latest", () => {
  const dbRow = {
    snapshot_id: "drr_snap0001",
    tenant_id: TENANT,
    ready: true,
    total_issues: 0,
    overdue_drills: 0,
    stale_runbooks: 0,
    expired_backups: 0,
    unverified_backups: 0,
    replication_violations: 0,
    failover_breaches: 0,
    drill_breaches: 0,
    report: assessDrReadiness({}),
    generated_at: new Date(NOW),
  };

  it("listRecent orders DESC with a LIMIT bind", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrReadinessStore(
      mockConnection(capture, { rows: [dbRow], rowCount: 1 }),
    );
    const rows = await store.listRecent(5);
    expect(capture[0]?.sql).toContain("ORDER BY generated_at DESC");
    expect(capture[0]?.params?.[0]).toBe(5);
    expect(rows[0]?.snapshotId).toBe("drr_snap0001");
    expect(rows[0]?.generatedAt).toBe(NOW);
  });

  it("latest returns the single newest snapshot", async () => {
    const store = new PostgresDrReadinessStore(
      mockConnection(undefined, { rows: [dbRow], rowCount: 1 }),
    );
    const row = await store.latest();
    expect(row?.snapshotId).toBe("drr_snap0001");
    expect(row?.ready).toBe(true);
  });

  it("latest returns null when empty", async () => {
    const store = new PostgresDrReadinessStore(
      mockConnection(undefined, { rows: [], rowCount: 0 }),
    );
    expect(await store.latest()).toBeNull();
  });

  it("parses a json string report column", async () => {
    const store = new PostgresDrReadinessStore(
      mockConnection(undefined, {
        rows: [{ ...dbRow, report: JSON.stringify(assessDrReadiness({})) }],
        rowCount: 1,
      }),
    );
    const row = await store.latest();
    expect(row?.report.ready).toBe(true);
  });

  it("rejects a non-positive listRecent limit", async () => {
    const store = new PostgresDrReadinessStore(mockConnection());
    await expect(store.listRecent(0)).rejects.toThrow();
  });
});
