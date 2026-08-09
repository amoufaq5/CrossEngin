import { describe, expect, it } from "vitest";
import {
  FailoverRecordSchema,
  type FailoverRecord,
} from "@crossengin/dr";
import { PostgresDrFailoverStore } from "./failover-store.js";
import { failoverExecutionRecordFrom } from "./records.js";
import { mockConnection, type Captured } from "./test-fakes.js";

const NOW = "2026-06-02T12:00:00.000Z";
const LATER = "2026-06-02T12:30:00.000Z";
const TENANT = "00000000-0000-4000-8000-000000000001";

function failover(overrides: Partial<FailoverRecord> = {}): FailoverRecord {
  return FailoverRecordSchema.parse({
    id: "fov_00000001",
    tier: "tier_1_business_critical",
    trigger: "planned_drill",
    triggeredBy: "operator-1",
    triggeredAt: NOW,
    fromRegion: "eu-central",
    toRegion: "us-east",
    affectedApps: ["billing"],
    status: "succeeded",
    startedAt: NOW,
    completedAt: LATER,
    durationSeconds: 1800,
    actualRpoSeconds: 30,
    actualRtoSeconds: 300,
    ...overrides,
  });
}

function record() {
  return failoverExecutionRecordFrom(failover(), {
    tenantId: TENANT,
    recordedAt: LATER,
    verdict: { rpoBreached: false, rtoBreached: false },
  });
}

describe("PostgresDrFailoverStore.record", () => {
  it("issues an INSERT ... ON CONFLICT DO NOTHING with bound params", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrFailoverStore(mockConnection(capture));
    await store.record(record());
    expect(capture[0]?.sql).toContain("INSERT INTO meta.dr_failover_executions");
    expect(capture[0]?.sql).toContain("ON CONFLICT (execution_id) DO NOTHING");
    expect(capture[0]?.sql).toContain("$15::jsonb");
    expect(capture[0]?.params?.[0]).toBe("fov_00000001");
    expect(capture[0]?.params?.[1]).toBe(TENANT);
    expect(capture[0]?.params?.[4]).toBe("succeeded");
    expect(capture[0]?.params?.[9]).toBe(30);
    expect(capture[0]?.params?.[11]).toBe(false);
  });

  it("serializes the full record as a json string", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrFailoverStore(mockConnection(capture));
    await store.record(record());
    const raw = capture[0]?.params?.[14];
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw as string).id).toBe("fov_00000001");
  });

  it("validates the record before insert", async () => {
    const store = new PostgresDrFailoverStore(mockConnection());
    const bad = { ...record(), executionId: "bad-id" };
    await expect(store.record(bad)).rejects.toThrow();
  });
});

describe("PostgresDrFailoverStore.listRecent", () => {
  const dbRow = {
    execution_id: "fov_00000001",
    tenant_id: TENANT,
    tier: "tier_1_business_critical",
    trigger: "planned_drill",
    status: "succeeded",
    from_region: "eu-central",
    to_region: "us-east",
    triggered_at: new Date(NOW),
    completed_at: new Date(LATER),
    actual_rpo_seconds: 30,
    actual_rto_seconds: 300,
    rpo_breached: false,
    rto_breached: false,
    incident_ticket_id: null,
    record: failover(),
    recorded_at: new Date(LATER),
  };

  it("orders DESC with a LIMIT bind and maps rows", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrFailoverStore(
      mockConnection(capture, { rows: [dbRow], rowCount: 1 }),
    );
    const rows = await store.listRecent(25);
    expect(capture[0]?.sql).toContain("ORDER BY recorded_at DESC");
    expect(capture[0]?.params?.[0]).toBe(25);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.executionId).toBe("fov_00000001");
    expect(rows[0]?.triggeredAt).toBe(NOW);
    expect(rows[0]?.completedAt).toBe(LATER);
    expect(rows[0]?.rpoBreached).toBe(false);
  });

  it("parses a json string record column", async () => {
    const store = new PostgresDrFailoverStore(
      mockConnection(undefined, {
        rows: [{ ...dbRow, record: JSON.stringify(failover()) }],
        rowCount: 1,
      }),
    );
    const rows = await store.listRecent();
    expect(rows[0]?.record.id).toBe("fov_00000001");
  });

  it("rejects a non-positive limit", async () => {
    const store = new PostgresDrFailoverStore(mockConnection());
    await expect(store.listRecent(0)).rejects.toThrow();
  });
});

describe("PostgresDrFailoverStore.countSince", () => {
  it("parses the count", async () => {
    const store = new PostgresDrFailoverStore(
      mockConnection(undefined, { rows: [{ count: "7" }], rowCount: 1 }),
    );
    expect(await store.countSince(new Date(NOW))).toBe(7);
  });

  it("returns 0 when there are no rows", async () => {
    const store = new PostgresDrFailoverStore(
      mockConnection(undefined, { rows: [], rowCount: 0 }),
    );
    expect(await store.countSince(new Date(NOW))).toBe(0);
  });
});
