import { describe, expect, it } from "vitest";
import {
  assessDrReadiness,
  DrReadinessReportSchema,
  type DrReadinessReport,
} from "@crossengin/dr-runtime";
import { PostgresDrReadinessStore } from "./readiness-store.js";
import {
  readinessSnapshotRecordFrom,
  SET_PLATFORM_RECORD_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
} from "./records.js";
import {
  collectUnreadable,
  EXPECT_ALL_READABLE,
  mockConnection,
  type Captured,
} from "./test-fakes.js";

/** An axis `DrEvidenceAxisSchema` refuses — what a newer binary's vocabulary looks like from here. */
const FORBIDDEN_AXIS = "zzz-not-an-axis";

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

/**
 * A report that is ready **and says so for a reason**, built explicitly.
 *
 * The subject of these tests is the row rather than the verdict, and `assessDrReadiness({})` is no
 * longer ready — an empty estate carries no record on four axes. Asserting `ready: true` off it was
 * asserting the defect `unevidencedAxes` closes, so the state is set here rather than inherited.
 */
function evidencedReport(): DrReadinessReport {
  return DrReadinessReportSchema.parse({
    ...assessDrReadiness({}),
    ready: true,
    unevidencedAxes: [],
  });
}

function readinessReportWithAxes(axes: readonly string[]): DrReadinessReport {
  return DrReadinessReportSchema.parse({
    ...assessDrReadiness({}),
    ready: false,
    unevidencedAxes: axes,
  });
}

function record(snapshotId = "drr_snap0001") {
  return readinessSnapshotRecordFrom(evidencedReport(), {
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
    expect(written(capture).sql).toContain("$13::jsonb");
    expect(written(capture).params?.[0]).toBe("drr_snap0001");
    expect(written(capture).params?.[1]).toBe(TENANT);
    expect(written(capture).params?.[2]).toBe(true);
    expect(written(capture).params?.[3]).toBe(0);
    expect(written(capture).params).toHaveLength(14);
  });

  it("projects unevidenced_axes as an array param, so NULL and [] stay different in the row", async () => {
    // Bound as the array itself and not through `JSON.stringify`, which would make both of them
    // strings a `TEXT[]` column refuses — and would collapse the distinction the column exists for.
    const capture: Captured[] = [];
    await new PostgresDrReadinessStore(mockConnection(capture)).record(record());
    expect(written(capture).sql).toContain("unevidenced_axes");
    expect(written(capture).params?.[11]).toEqual([]);
  });

  it("binds a non-empty axis list and a null through the same position", async () => {
    const unevidenced = readinessSnapshotRecordFrom(report(), {
      tenantId: TENANT,
      generatedAt: NOW,
      snapshotId: "drr_snap0002",
    });
    const a: Captured[] = [];
    await new PostgresDrReadinessStore(mockConnection(a)).record(unevidenced);
    expect(written(a).params?.[11]).toEqual([
      "drills",
      "runbooks",
      "backups",
      "replication",
    ]);

    const predating: Record<string, unknown> = { ...assessDrReadiness({}) };
    delete predating["unevidencedAxes"];
    const b: Captured[] = [];
    await new PostgresDrReadinessStore(mockConnection(b)).record(
      readinessSnapshotRecordFrom(DrReadinessReportSchema.parse(predating), {
        tenantId: TENANT,
        generatedAt: NOW,
        snapshotId: "drr_snap0003",
      }),
    );
    expect(written(b).params?.[11]).toBeNull();
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
    // Index 12, not 11: `unevidenced_axes` is projected between `drill_breaches` and `report`, as
    // the catalog declares it. A positional read is brittle by nature, which is why the bind arity
    // and the column list are asserted separately rather than relying on this one.
    const raw = written(capture).params?.[12];
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
    unevidenced_axes: [],
    report: evidencedReport(),
    generated_at: new Date(NOW),
  };

  it("listRecent orders DESC with a LIMIT bind", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrReadinessStore(
      mockConnection(capture, { rows: [dbRow], rowCount: 1 }),
    );
    const rows = await store.listRecent(null, EXPECT_ALL_READABLE, 5);
    expect(capture[0]?.sql).toContain("ORDER BY generated_at DESC");
    expect(capture[0]?.params?.[0]).toBe(5);
    expect(rows[0]?.snapshotId).toBe("drr_snap0001");
    expect(rows[0]?.generatedAt).toBe(NOW);
  });

  it("selects unevidenced_axes too, so the write and the read cannot disagree", async () => {
    // Both statements interpolate one `COLUMNS` constant, which makes the divergence
    // unrepresentable — this pins that the read path still reads *that* constant rather than a
    // list of its own, which is the edit that would reintroduce it. The fake cannot catch it: it
    // hands back the rows the test author wrote, so a SELECT missing a column still round-trips
    // the fixture.
    const capture: Captured[] = [];
    await new PostgresDrReadinessStore(mockConnection(capture)).listRecent(
      null,
      EXPECT_ALL_READABLE,
      5,
    );
    expect(capture[0]?.sql).toContain("unevidenced_axes");
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
        rows: [{ ...dbRow, report: JSON.stringify(evidencedReport()) }],
        rowCount: 1,
      }),
    );
    const row = await store.latest(null);
    expect(row?.report.ready).toBe(true);
  });

  it("maps a SQL NULL unevidenced_axes to null and never to []", async () => {
    // Collapsing them here would undo the distinction the column exists for one layer up: `null`
    // is a row written before this check and `[]` is the claim that every axis carried a record.
    const store = new PostgresDrReadinessStore(
      mockConnection(undefined, {
        rows: [{ ...dbRow, unevidenced_axes: null }],
        rowCount: 1,
      }),
    );
    const row = await store.latest(null);
    expect(row?.unevidencedAxes).toBeNull();
    expect(row?.unevidencedAxes).not.toEqual([]);
  });

  it("reads an empty array back as the claim it is", async () => {
    const store = new PostgresDrReadinessStore(
      mockConnection(undefined, { rows: [{ ...dbRow, unevidenced_axes: [] }], rowCount: 1 }),
    );
    expect((await store.latest(null))?.unevidencedAxes).toEqual([]);
  });

  it("reads a non-empty axis list back", async () => {
    const store = new PostgresDrReadinessStore(
      mockConnection(undefined, {
        rows: [
          {
            ...dbRow,
            ready: false,
            unevidenced_axes: ["backups", "drills"],
            report: readinessReportWithAxes(["backups", "drills"]),
          },
        ],
        rowCount: 1,
      }),
    );
    const row = await store.latest(null);
    expect(row?.unevidencedAxes).toEqual(["backups", "drills"]);
    expect(row?.report.unevidencedAxes).toEqual(["backups", "drills"]);
  });

  it("refuses a stored axis this binary does not recognise rather than coercing it", async () => {
    const store = new PostgresDrReadinessStore(
      mockConnection(undefined, {
        rows: [{ ...dbRow, unevidenced_axes: ["restores"] }],
        rowCount: 1,
      }),
    );
    await expect(store.latest(null)).rejects.toThrow();
  });

  it("rejects a non-positive listRecent limit", async () => {
    const store = new PostgresDrReadinessStore(mockConnection());
    await expect(store.listRecent(null, EXPECT_ALL_READABLE, 0)).rejects.toThrow();
  });

  /**
   * `listRecent` has **no caller anywhere in the workspace**, so these two pin the artifact and not
   * a deployment: the row they describe is a stored readiness verdict, which is what an auditor
   * reads, and a reader added later would otherwise inherit the `.map` that drops its neighbours.
   * The unreadable row is the one `latest` already refuses above — an axis this binary does not
   * recognise — which is the realistic case for this table, since a newer binary's vocabulary is
   * how a correct row becomes unrepresentable here.
   */
  function unreadableDbRow() {
    return { ...dbRow, snapshot_id: "drr_snap0002", unevidenced_axes: [FORBIDDEN_AXIS] };
  }

  it("listRecent returns the readable rows and reports the one it could not represent", async () => {
    const seen = collectUnreadable();
    const store = new PostgresDrReadinessStore(
      mockConnection(undefined, {
        rows: [dbRow, unreadableDbRow(), { ...dbRow, snapshot_id: "drr_snap0003" }],
        rowCount: 3,
      }),
    );
    const rows = await store.listRecent(null, seen.report, 5);
    expect(rows.map((r) => r.snapshotId)).toEqual(["drr_snap0001", "drr_snap0003"]);
    expect(seen.rows).toHaveLength(1);
    expect(seen.rows[0]?.identity).toBe("drr_snap0002");
  });

  it("listRecent names a field path and an issue code, and no value off the row", async () => {
    const seen = collectUnreadable();
    const store = new PostgresDrReadinessStore(
      mockConnection(undefined, { rows: [unreadableDbRow()], rowCount: 1 }),
    );
    await store.listRecent(null, seen.report, 5);
    const detail = seen.rows[0]?.detail ?? "";
    expect(detail).toContain("unevidencedAxes.0");
    expect(detail).toContain("invalid_enum_value");
    expect(detail).not.toContain(FORBIDDEN_AXIS);
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
    await new PostgresDrReadinessStore(mockConnection(capture)).listRecent(
      null,
      EXPECT_ALL_READABLE,
      5,
    );
    expect(capture.some((c) => c.sql.includes("set_config"))).toBe(false);
  });
});
