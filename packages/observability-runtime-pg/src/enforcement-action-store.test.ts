import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";
import {
  PostgresSloEnforcementActionStore,
  SLO_ENFORCEMENT_ACTION_COLUMNS,
} from "./enforcement-action-store.js";
import {
  SET_PLATFORM_RECORD_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
  type SloEnforcementActionRecord,
} from "./records.js";

/** `{sql, params}` as the offline fakes in this file record it. */
interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

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
    // `scopedWrite` runs its write inside a transaction, so a fake whose `transaction` returns
    // undefined silently drops the statement under test.
    transaction: vi.fn(async <T>(fn: (tx: PgConnection) => Promise<T>) =>
      fn(mockConnection(capture, result)),
    ) as PgConnection["transaction"],
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
    expect(written(capture).sql).toContain("INSERT INTO meta.slo_enforcement_actions");
    expect(written(capture).sql).toContain("ON CONFLICT (action_id) DO NOTHING");
    const insert = written(capture);
    if (insert === undefined) throw new Error("no statement recorded");
    expect(bound(insert, "signal")).toBe("availability");
    expect(bound(insert, "incident_id")).toBe("INC-2026-0001");
  });

  it("binds one placeholder per stored column", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEnforcementActionStore(mockConnection(capture));
    await store.record(fixture());
    const count = SLO_ENFORCEMENT_ACTION_COLUMNS.length;
    expect(written(capture).params).toHaveLength(count);
    expect(written(capture).sql).toContain(`$${count}`);
    expect(written(capture).sql).not.toContain(`$${count + 1}`);
  });

  it("writes the close-out column", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEnforcementActionStore(mockConnection(capture));
    await store.record(recoveredFixture({ closeOut: "human_owned" }));
    expect(written(capture).sql).toContain("close_out");
    const insert = written(capture);
    if (insert === undefined) throw new Error("no statement recorded");
    expect(bound(insert, "close_out")).toBe("human_owned");
  });

  it("binds a null close-out for a non-recovery", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEnforcementActionStore(mockConnection(capture));
    await store.record(fixture());
    const insert = written(capture);
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

describe("the platform write arm", () => {
  it("claims app.platform_record_write before a platform-scope write", async () => {
    // An SLO surface is never a tenant (ADR-0327), so an enforcement action about one is routinely
    // platform-scope — which is exactly the row the old single policy let any tenant session forge.
    const capture: Captured[] = [];
    const store = new PostgresSloEnforcementActionStore(mockConnection(capture));
    await store.record(fixture({ tenantId: null }));
    expect(capture[0]?.sql).toBe(SET_PLATFORM_RECORD_WRITE_SQL);
    expect(written(capture).sql).toContain("INSERT INTO meta.slo_enforcement_actions");
  });

  it("claims the tenant context instead for a tenant-scope write, never both", async () => {
    const capture: Captured[] = [];
    await new PostgresSloEnforcementActionStore(mockConnection(capture)).record(fixture());
    const settings = capture.filter((c) => c.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    expect(settings[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
  });

  it("does not reach the kill switch it names, which is on the config grant", () => {
    // The action row records that a flag was rolled back; `meta.feature_flag_kill_switches` is the
    // rollback itself. One grant covering both would let the thing that reports an enforcement
    // perform one.
    expect(SET_PLATFORM_RECORD_WRITE_SQL).not.toContain("app.platform_config_write");
  });
});

describe("the scope predicate every read carries beside RLS", () => {
  const SINCE = new Date("2026-01-01T00:00:00.000Z");

  it("scopes listForIncident, so two scopes on one incident id cannot read as a duplicate open", async () => {
    const capture: Captured[] = [];
    await new PostgresSloEnforcementActionStore(mockConnection(capture)).listForIncident(
      "INC-2026-0001",
    );
    const read = written(capture);
    expect(read.sql).toContain("tenant_id IS NULL");
    expect(read.params).toEqual(["INC-2026-0001"]);
  });

  it("scopes listRecent before the LIMIT, so another scope cannot displace this one's page", async () => {
    const capture: Captured[] = [];
    await new PostgresSloEnforcementActionStore(mockConnection(capture)).listRecent(25);
    const platform = written(capture);
    expect(platform.sql).toContain("WHERE tenant_id IS NULL");
    expect(platform.sql).toContain("LIMIT $1");
    expect(platform.params).toEqual([25]);

    const tenantCapture: Captured[] = [];
    await new PostgresSloEnforcementActionStore(mockConnection(tenantCapture)).listRecent(
      25,
      TENANT,
    );
    const tenant = written(tenantCapture);
    expect(tenant.sql).toContain("WHERE tenant_id = $1");
    expect(tenant.sql).toContain("LIMIT $2");
    // The order is load-bearing: the scope narrows the set the LIMIT is taken from.
    expect(tenant.params).toEqual([TENANT, 25]);
  });

  it("scopes countSince, the read whose wrongness is a scalar", async () => {
    const capture: Captured[] = [];
    await new PostgresSloEnforcementActionStore(mockConnection(capture)).countSince(SINCE);
    expect(written(capture).sql).toContain("tenant_id IS NULL");

    const tenantCapture: Captured[] = [];
    await new PostgresSloEnforcementActionStore(mockConnection(tenantCapture)).countSince(
      SINCE,
      TENANT,
    );
    const tenant = written(tenantCapture);
    expect(tenant.sql).toContain("tenant_id = $2");
    expect(tenant.params).toEqual([SINCE.toISOString(), TENANT]);
  });

  it("never spells a scope as IS NOT DISTINCT FROM, on any read", async () => {
    const capture: Captured[] = [];
    const store = new PostgresSloEnforcementActionStore(mockConnection(capture));
    await store.listForIncident("INC-2026-0001", TENANT);
    await store.listRecent(5, TENANT);
    await store.countSince(SINCE, TENANT);
    const reads = capture.filter((c) => !c.sql.includes("set_config"));
    expect(reads).toHaveLength(3);
    for (const read of reads) {
      expect(read.sql).not.toContain("IS NOT DISTINCT FROM");
      expect(read.sql).toContain("tenant_id = $");
    }
  });
});
