import { describe, expect, it } from "vitest";
import { DrillRecordSchema, type DrillRecord } from "@crossengin/dr";
import { PostgresDrDrillStore } from "./drill-store.js";
import {
  drillExecutionRecordFrom,
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
const LATER = "2026-06-02T12:30:00.000Z";
const DUE = "2026-09-02T12:00:00.000Z";
const TENANT = "00000000-0000-4000-8000-000000000001";

function drill(overrides: Partial<DrillRecord> = {}): DrillRecord {
  return DrillRecordSchema.parse({
    id: "drl_00000001",
    kind: "restore_test",
    tier: "tier_1_business_critical",
    scheduledFor: NOW,
    executedAt: LATER,
    executedBy: "operator-1",
    scopeRegions: ["eu-central"],
    scopeApps: ["billing"],
    outcome: "passed",
    measuredRpoSeconds: 20,
    measuredRtoSeconds: 200,
    nextDrillDueAt: DUE,
    ...overrides,
  });
}

function record() {
  return drillExecutionRecordFrom(drill(), {
    tenantId: TENANT,
    recordedAt: LATER,
    verdict: { rpoBreached: false, rtoBreached: false, passing: true },
  });
}

describe("PostgresDrDrillStore.record", () => {
  it("issues an INSERT ... ON CONFLICT DO NOTHING with bound params", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrDrillStore(mockConnection(capture));
    await store.record(record());
    expect(written(capture).sql).toContain("INSERT INTO meta.dr_drill_executions");
    expect(written(capture).sql).toContain("ON CONFLICT (execution_id) DO NOTHING");
    expect(written(capture).sql).toContain("$11::jsonb");
    expect(written(capture).params?.[0]).toBe("drl_00000001");
    expect(written(capture).params?.[1]).toBe(TENANT);
    expect(written(capture).params?.[2]).toBe("restore_test");
    expect(written(capture).params?.[4]).toBe("passed");
    expect(written(capture).params?.[5]).toBe(true);
  });

  it("serializes the full record as a json string", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrDrillStore(mockConnection(capture));
    await store.record(record());
    const raw = written(capture).params?.[10];
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw as string).id).toBe("drl_00000001");
  });

  it("validates the record before insert", async () => {
    const store = new PostgresDrDrillStore(mockConnection());
    const bad = { ...record(), executionId: "nope" };
    await expect(store.record(bad)).rejects.toThrow();
  });
});

describe("PostgresDrDrillStore.listRecent", () => {
  const dbRow = {
    execution_id: "drl_00000001",
    tenant_id: TENANT,
    kind: "restore_test",
    tier: "tier_1_business_critical",
    outcome: "passed",
    passing: true,
    rpo_breached: false,
    rto_breached: false,
    scheduled_for: new Date(NOW),
    executed_at: new Date(LATER),
    record: drill(),
    recorded_at: new Date(LATER),
  };

  it("orders DESC with a LIMIT bind and maps rows", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrDrillStore(
      mockConnection(capture, { rows: [dbRow], rowCount: 1 }),
    );
    const rows = await store.listRecent(10);
    expect(capture[0]?.sql).toContain("ORDER BY recorded_at DESC");
    expect(capture[0]?.params?.[0]).toBe(10);
    expect(rows[0]?.executionId).toBe("drl_00000001");
    expect(rows[0]?.passing).toBe(true);
    expect(rows[0]?.scheduledFor).toBe(NOW);
    expect(rows[0]?.executedAt).toBe(LATER);
  });

  it("maps a null executed_at back to null", async () => {
    const store = new PostgresDrDrillStore(
      mockConnection(undefined, {
        rows: [
          {
            ...dbRow,
            outcome: "not_executed",
            passing: null,
            executed_at: null,
            record: drill({
              outcome: "not_executed",
              executedAt: null,
              executedBy: null,
              measuredRpoSeconds: null,
              measuredRtoSeconds: null,
            }),
          },
        ],
        rowCount: 1,
      }),
    );
    const rows = await store.listRecent();
    expect(rows[0]?.executedAt).toBeNull();
    expect(rows[0]?.passing).toBeNull();
  });

  it("rejects a non-positive limit", async () => {
    const store = new PostgresDrDrillStore(mockConnection());
    await expect(store.listRecent(-1)).rejects.toThrow();
  });
});

describe("PostgresDrDrillStore.countSince", () => {
  it("parses the count", async () => {
    const store = new PostgresDrDrillStore(
      mockConnection(undefined, { rows: [{ count: "3" }], rowCount: 1 }),
    );
    expect(await store.countSince(new Date(NOW))).toBe(3);
  });
});

describe("the platform write arm", () => {
  it("claims app.platform_record_write before a platform-scope write", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrDrillStore(mockConnection(capture));
    await store.record({ ...record(), tenantId: null });
    expect(capture[0]?.sql).toBe(SET_PLATFORM_RECORD_WRITE_SQL);
    expect(written(capture).sql).toContain("INSERT INTO meta.dr_drill_executions");
  });

  it("claims the tenant context instead for a tenant-scope write, never both", async () => {
    const capture: Captured[] = [];
    await new PostgresDrDrillStore(mockConnection(capture)).record(record());
    const settings = capture.filter((c) => c.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    expect(settings[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
  });

  it("claims nothing at all on a read, which the split left unchanged", async () => {
    const capture: Captured[] = [];
    await new PostgresDrDrillStore(mockConnection(capture)).listRecent(10);
    expect(capture.some((c) => c.sql.includes("set_config"))).toBe(false);
  });
});
