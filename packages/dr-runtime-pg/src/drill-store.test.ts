import { describe, expect, it } from "vitest";
import { DrillRecordSchema, type DrillRecord } from "@crossengin/dr";
import { PostgresDrDrillStore } from "./drill-store.js";
import { drillExecutionRecordFrom } from "./records.js";
import { mockConnection, type Captured } from "./test-fakes.js";

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
    expect(capture[0]?.sql).toContain("INSERT INTO meta.dr_drill_executions");
    expect(capture[0]?.sql).toContain("ON CONFLICT (execution_id) DO NOTHING");
    expect(capture[0]?.sql).toContain("$11::jsonb");
    expect(capture[0]?.params?.[0]).toBe("drl_00000001");
    expect(capture[0]?.params?.[1]).toBe(TENANT);
    expect(capture[0]?.params?.[2]).toBe("restore_test");
    expect(capture[0]?.params?.[4]).toBe("passed");
    expect(capture[0]?.params?.[5]).toBe(true);
  });

  it("serializes the full record as a json string", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrDrillStore(mockConnection(capture));
    await store.record(record());
    const raw = capture[0]?.params?.[10];
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
