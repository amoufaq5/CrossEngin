import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";
import {
  PostgresSloEnforcementActionStore,
  SLO_ENFORCEMENT_ACTION_COLUMNS,
} from "./enforcement-action-store.js";
import type { SloEnforcementActionRecord } from "./records.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

/**
 * Bound parameters are positional, but the position is derived from the stored column order rather
 * than written down — a column added in the middle used to shift every literal index in this file.
 */
function bound(
  capture: { params: readonly unknown[] | undefined },
  column: string,
): unknown {
  const index = SLO_ENFORCEMENT_ACTION_COLUMNS.indexOf(column);
  expect(index).toBeGreaterThanOrEqual(0);
  return capture.params?.[index];
}

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
    signal: "availability",
    decision: "breach_opened",
    severity: "sev2",
    incidentId: "INC-2026-0001",
    killSwitchId: "fks_auto00000001",
    flagId: "ff_checkout01",
    paged: true,
    pageChannelCount: 1,
    thresholdId: "fast-burn",
    closeOut: null,
    occurredAt: "2026-06-02T12:00:00.000Z",
    ...overrides,
  };
}

function recoveredFixture(
  overrides: Partial<SloEnforcementActionRecord> = {},
): SloEnforcementActionRecord {
  return fixture({
    actionId: "sloa_auto00000002",
    decision: "recovered",
    severity: null,
    flagId: null,
    paged: false,
    pageChannelCount: 0,
    thresholdId: null,
    closeOut: "cancelled",
    ...overrides,
  });
}

const dbRow = {
  action_id: "sloa_auto00000001",
  tenant_id: TENANT,
  slo_id: "orders-availability",
  surface: "POST /v1/orders",
  signal: "availability",
  decision: "breach_opened",
  severity: "sev2",
  incident_id: "INC-2026-0001",
  kill_switch_id: "fks_auto00000001",
  flag_id: "ff_checkout01",
  paged: true,
  page_channel_count: 1,
  threshold_id: "fast-burn",
  close_out: null,
  occurred_at: new Date("2026-06-02T12:00:00.000Z"),
};

const recoveredDbRow = {
  ...dbRow,
  action_id: "sloa_auto00000002",
  decision: "recovered",
  severity: null,
  flag_id: null,
  paged: false,
  page_channel_count: 0,
  threshold_id: null,
  close_out: "cancelled",
};

describe("PostgresSloEnforcementActionStore.record", () => {
  it("issues an INSERT ... ON CONFLICT DO NOTHING", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEnforcementActionStore(mockConnection(capture));
    await store.record(fixture());
    expect(capture[0]?.sql).toContain("INSERT INTO meta.slo_enforcement_actions");
    expect(capture[0]?.sql).toContain("ON CONFLICT (action_id) DO NOTHING");
    const insert = capture[0];
    if (insert === undefined) throw new Error("no statement recorded");
    expect(bound(insert, "signal")).toBe("availability");
    expect(bound(insert, "incident_id")).toBe("INC-2026-0001");
  });

  it("binds one placeholder per stored column", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEnforcementActionStore(mockConnection(capture));
    await store.record(fixture());
    const count = SLO_ENFORCEMENT_ACTION_COLUMNS.length;
    expect(capture[0]?.params).toHaveLength(count);
    expect(capture[0]?.sql).toContain(`$${count}`);
    expect(capture[0]?.sql).not.toContain(`$${count + 1}`);
  });

  it("writes the close-out column", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEnforcementActionStore(mockConnection(capture));
    await store.record(recoveredFixture({ closeOut: "human_owned" }));
    expect(capture[0]?.sql).toContain("close_out");
    const insert = capture[0];
    if (insert === undefined) throw new Error("no statement recorded");
    expect(bound(insert, "close_out")).toBe("human_owned");
  });

  it("binds a null close-out for a non-recovery", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEnforcementActionStore(mockConnection(capture));
    await store.record(fixture());
    const insert = capture[0];
    if (insert === undefined) throw new Error("no statement recorded");
    expect(bound(insert, "close_out")).toBeNull();
  });

  it("stores close_out immediately before occurred_at", async () => {
    // The meta-schema column order; the reconciler compares positions.
    const closeOutAt = SLO_ENFORCEMENT_ACTION_COLUMNS.indexOf("close_out");
    expect(SLO_ENFORCEMENT_ACTION_COLUMNS[closeOutAt + 1]).toBe("occurred_at");
  });

  it("validates the record before insert", async () => {
    const store = new PostgresSloEnforcementActionStore(mockConnection());
    await expect(store.record(fixture({ incidentId: "bad-id" }))).rejects.toThrow();
  });

  it("refuses a recovered record with no close-out before it reaches SQL", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEnforcementActionStore(mockConnection(capture));
    await expect(
      store.record(recoveredFixture({ closeOut: null })),
    ).rejects.toThrow();
    expect(capture).toHaveLength(0);
  });

  it("refuses a breach_opened record carrying a close-out", async () => {
    const store = new PostgresSloEnforcementActionStore(mockConnection());
    await expect(store.record(fixture({ closeOut: "cancelled" }))).rejects.toThrow();
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
    expect(rows[0]?.closeOut).toBeNull();
  });

  it("reads a recovery's close-out back off the row", async () => {
    const store = new PostgresSloEnforcementActionStore(
      mockConnection(undefined, { rows: [recoveredDbRow], rowCount: 1 }),
    );
    const rows = await store.listForIncident("INC-2026-0001");
    expect(rows[0]?.decision).toBe("recovered");
    expect(rows[0]?.closeOut).toBe("cancelled");
  });

  it("maps a missing close_out column to null rather than guessing", async () => {
    // A row read through a projection that omits the column must not read as a recovery outcome.
    const { close_out: _omitted, ...withoutCloseOut } = recoveredDbRow;
    const store = new PostgresSloEnforcementActionStore(
      mockConnection(undefined, {
        rows: [{ ...withoutCloseOut, decision: "breach_ongoing" }],
        rowCount: 1,
      }),
    );
    const rows = await store.listForIncident("INC-2026-0001");
    expect(rows[0]?.closeOut).toBeNull();
  });

  it("refuses a row whose decision and close-out contradict each other", async () => {
    // Only the schema can catch this: the column's CHECK constrains the value, not the pairing.
    const store = new PostgresSloEnforcementActionStore(
      mockConnection(undefined, {
        rows: [{ ...recoveredDbRow, decision: "breach_ongoing" }],
        rowCount: 1,
      }),
    );
    await expect(store.listForIncident("INC-2026-0001")).rejects.toThrow();
  });

  it("selects the close_out column", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEnforcementActionStore(
      mockConnection(capture, { rows: [], rowCount: 0 }),
    );
    await store.listForIncident("INC-2026-0001");
    expect(capture[0]?.sql).toContain("close_out");
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
    expect(capture[0]?.sql).toContain("close_out");
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
