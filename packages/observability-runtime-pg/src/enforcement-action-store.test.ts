import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresSloEnforcementActionStore } from "./enforcement-action-store.js";
import type { SloEnforcementActionRecord } from "./records.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function mockConnection(
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
  result: PgQueryResult = { rows: [], rowCount: 1 },
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (capture !== undefined) capture.push({ sql, params });
      return result;
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

function fixture(
  overrides: Partial<SloEnforcementActionRecord> = {},
): SloEnforcementActionRecord {
  return {
    actionId: "sloa_auto00000001",
    tenantId: TENANT,
    sloId: "orders-availability",
    surface: "POST /v1/orders",
    decision: "breach_opened",
    severity: "sev2",
    incidentId: "INC-2026-0001",
    killSwitchId: "fks_auto00000001",
    flagId: "ff_checkout01",
    paged: true,
    pageChannelCount: 1,
    thresholdId: "fast-burn",
    occurredAt: "2026-06-02T12:00:00.000Z",
    ...overrides,
  };
}

const dbRow = {
  action_id: "sloa_auto00000001",
  tenant_id: TENANT,
  slo_id: "orders-availability",
  surface: "POST /v1/orders",
  decision: "breach_opened",
  severity: "sev2",
  incident_id: "INC-2026-0001",
  kill_switch_id: "fks_auto00000001",
  flag_id: "ff_checkout01",
  paged: true,
  page_channel_count: 1,
  threshold_id: "fast-burn",
  occurred_at: new Date("2026-06-02T12:00:00.000Z"),
};

describe("PostgresSloEnforcementActionStore.record", () => {
  it("issues an INSERT ... ON CONFLICT DO NOTHING", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEnforcementActionStore(mockConnection(capture));
    await store.record(fixture());
    expect(capture[0]?.sql).toContain("INSERT INTO meta.slo_enforcement_actions");
    expect(capture[0]?.sql).toContain("ON CONFLICT (action_id) DO NOTHING");
    expect(capture[0]?.params?.[6]).toBe("INC-2026-0001");
  });

  it("validates the record before insert", async () => {
    const store = new PostgresSloEnforcementActionStore(mockConnection());
    await expect(store.record(fixture({ incidentId: "bad-id" }))).rejects.toThrow();
  });
});

describe("PostgresSloEnforcementActionStore.listForIncident", () => {
  it("maps db rows back to records (Date occurred_at -> ISO)", async () => {
    const store = new PostgresSloEnforcementActionStore(
      mockConnection(undefined, { rows: [dbRow], rowCount: 1 }),
    );
    const rows = await store.listForIncident("INC-2026-0001");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actionId).toBe("sloa_auto00000001");
    expect(rows[0]?.occurredAt).toBe("2026-06-02T12:00:00.000Z");
    expect(rows[0]?.paged).toBe(true);
  });
});

describe("PostgresSloEnforcementActionStore.listRecent", () => {
  it("orders DESC with a LIMIT bind", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEnforcementActionStore(
      mockConnection(capture, { rows: [dbRow], rowCount: 1 }),
    );
    await store.listRecent(25);
    expect(capture[0]?.sql).toContain("ORDER BY occurred_at DESC");
    expect(capture[0]?.params?.[0]).toBe(25);
  });

  it("rejects a non-positive limit", async () => {
    const store = new PostgresSloEnforcementActionStore(mockConnection());
    await expect(store.listRecent(0)).rejects.toThrow();
  });
});

describe("PostgresSloEnforcementActionStore.countSince", () => {
  it("parses the count", async () => {
    const store = new PostgresSloEnforcementActionStore(
      mockConnection(undefined, { rows: [{ count: "12" }], rowCount: 1 }),
    );
    expect(await store.countSince(new Date())).toBe(12);
  });
});
