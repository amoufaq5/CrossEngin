import { describe, expect, it } from "vitest";
import { assessDrReadiness } from "@crossengin/dr-runtime";
import { PostgresDrReadinessStore } from "./readiness-store.js";
import {
  readinessSnapshotRecordFrom,
  SET_PLATFORM_RECORD_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
} from "./records.js";
import { mockConnection, type Captured } from "./test-fakes.js";

/**
 * The statement under test, found by what it *is* rather than by where it sits.
 *
 * `scopedWrite` issues a session setting before the write, so every positional `capture[0]` in a
 * write test would otherwise have had to shift by one — and would shift again the next time a
 * statement joins the transaction. Asserting on the session setting itself is a separate test.
 */
function written(capture: readonly Captured[]): Captured {
  const found = capture.find((c) => !c.sql.includes("set_config"));
  if (found === undefined) throw new Error("no statement other than the session setting was issued");
  return found;
}

const NOW = "2026-06-02T12:00:00.000Z";
const TENANT = "00000000-0000-4000-8000-000000000001";

function report() {
  return assessDrReadiness({});
}

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
    expect(written(capture).sql).toContain("INSERT INTO meta.dr_readiness_snapshots");
    expect(written(capture).sql).toContain("ON CONFLICT (snapshot_id) DO NOTHING");
    expect(written(capture).sql).toContain("$12::jsonb");
    expect(written(capture).params?.[0]).toBe("drr_snap0001");
    expect(written(capture).params?.[1]).toBe(TENANT);
    expect(written(capture).params?.[2]).toBe(true);
    expect(written(capture).params?.[3]).toBe(0);
  });

  it("keeps DO NOTHING deliberately, and is not the upsert the other two stores needed", async () => {
    // The failover and drill stores wrote `DO NOTHING` on a path the executor uses as an upsert, so
    // every transition after the first was dropped in silence. A readiness snapshot is not that
    // shape: no runtime method takes a report and returns a changed one under the same id, and
    // `readinessSnapshotRecordFrom` mints a fresh `drr_…` per assessment — so the only way to reach
    // this conflict is a caller repeating an explicit id, which means "write this once".
    //
    // The catalog agrees: `meta.dr_readiness_snapshots` has no `UPDATE` policy arm, so a
    // platform-scope snapshot is immutable-by-RLS once written. A later assessment rewriting an
    // earlier verdict under its id is the thing this must not become.
    const capture: Captured[] = [];
    await new PostgresDrReadinessStore(mockConnection(capture)).record(record());
    expect(written(capture).sql).toContain("DO NOTHING");
    expect(written(capture).sql).not.toContain("DO UPDATE");
  });

  it("mints a different snapshot id per assessment, so the conflict is unreachable by default", () => {
    const a = readinessSnapshotRecordFrom(report(), { tenantId: TENANT, generatedAt: NOW });
    const b = readinessSnapshotRecordFrom(report(), { tenantId: TENANT, generatedAt: NOW });
    expect(a.snapshotId).not.toBe(b.snapshotId);
  });

  it("serializes the full report as a json string", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrReadinessStore(mockConnection(capture));
    await store.record(record());
    const raw = written(capture).params?.[11];
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
    const rows = await store.listRecent(null, 5);
    expect(capture[0]?.sql).toContain("ORDER BY generated_at DESC");
    expect(capture[0]?.params?.[0]).toBe(5);
    expect(rows[0]?.snapshotId).toBe("drr_snap0001");
    expect(rows[0]?.generatedAt).toBe(NOW);
  });

  it("latest returns the single newest snapshot", async () => {
    const store = new PostgresDrReadinessStore(
      mockConnection(undefined, { rows: [dbRow], rowCount: 1 }),
    );
    const row = await store.latest(null);
    expect(row?.snapshotId).toBe("drr_snap0001");
    expect(row?.ready).toBe(true);
  });

  it("latest returns null when empty", async () => {
    const store = new PostgresDrReadinessStore(
      mockConnection(undefined, { rows: [], rowCount: 0 }),
    );
    expect(await store.latest(null)).toBeNull();
  });

  it("parses a json string report column", async () => {
    const store = new PostgresDrReadinessStore(
      mockConnection(undefined, {
        rows: [{ ...dbRow, report: JSON.stringify(assessDrReadiness({})) }],
        rowCount: 1,
      }),
    );
    const row = await store.latest(null);
    expect(row?.report.ready).toBe(true);
  });

  it("rejects a non-positive listRecent limit", async () => {
    const store = new PostgresDrReadinessStore(mockConnection());
    await expect(store.listRecent(null, 0)).rejects.toThrow();
  });
});

describe("the platform write arm", () => {
  it("claims app.platform_record_write before a platform-scope write", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrReadinessStore(mockConnection(capture));
    await store.record({ ...record(), tenantId: null });
    expect(capture[0]?.sql).toBe(SET_PLATFORM_RECORD_WRITE_SQL);
    expect(written(capture).sql).toContain("INSERT INTO meta.dr_readiness_snapshots");
  });

  it("claims the tenant context instead for a tenant-scope write, never both", async () => {
    const capture: Captured[] = [];
    await new PostgresDrReadinessStore(mockConnection(capture)).record(record());
    const settings = capture.filter((c) => c.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    expect(settings[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
  });

  it("claims nothing at all on a read, which the split left unchanged", async () => {
    const capture: Captured[] = [];
    await new PostgresDrReadinessStore(mockConnection(capture)).listRecent(null, 5);
    expect(capture.some((c) => c.sql.includes("set_config"))).toBe(false);
  });
});
