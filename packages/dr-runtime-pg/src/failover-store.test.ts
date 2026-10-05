import { describe, expect, it } from "vitest";
import {
  FailoverRecordSchema,
  type FailoverRecord,
} from "@crossengin/dr";
import { PostgresDrFailoverStore } from "./failover-store.js";
import {
  SET_PLATFORM_RECORD_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
  failoverExecutionRecordFrom,
  scopedWrite,
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
    expect(written(capture).sql).toContain("INSERT INTO meta.dr_failover_executions");
    expect(written(capture).sql).toContain("ON CONFLICT (execution_id) DO NOTHING");
    expect(written(capture).sql).toContain("$15::jsonb");
    expect(written(capture).params?.[0]).toBe("fov_00000001");
    expect(written(capture).params?.[1]).toBe(TENANT);
    expect(written(capture).params?.[4]).toBe("succeeded");
    expect(written(capture).params?.[9]).toBe(30);
    expect(written(capture).params?.[11]).toBe(false);
  });

  it("serializes the full record as a json string", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrFailoverStore(mockConnection(capture));
    await store.record(record());
    const raw = written(capture).params?.[14];
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

describe("the platform write arm", () => {
  it("claims app.platform_record_write before a platform-scope write", async () => {
    // This store used to set nothing at all, which worked only because the deployment connects as
    // the table's owner and an owner bypasses its policies. As a non-owner the one `ALL`-scope
    // policy admitted a platform row unconditionally — the defect — so the write arm is now a
    // separate `INSERT`-scoped policy on this setting.
    const capture: Captured[] = [];
    const store = new PostgresDrFailoverStore(mockConnection(capture));
    await store.record(
      failoverExecutionRecordFrom(failover(), { tenantId: null, recordedAt: LATER }),
    );
    expect(capture[0]?.sql).toBe(SET_PLATFORM_RECORD_WRITE_SQL);
    expect(capture[0]?.sql).toContain("app.platform_record_write");
    expect(capture[1]?.sql).toContain("INSERT INTO meta.dr_failover_executions");
  });

  it("claims the tenant context instead for a tenant-scope write, never both", async () => {
    const capture: Captured[] = [];
    await new PostgresDrFailoverStore(mockConnection(capture)).record(record());
    const settings = capture.filter((c) => c.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    expect(settings[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(settings[0]?.params).toEqual([TENANT]);
  });

  it("claims nothing at all on a read, which the split left unchanged", async () => {
    // The platform read policy is `SELECT`-scoped on `tenant_id IS NULL` and demands no grant, so a
    // read behaves exactly as it did before the split.
    const capture: Captured[] = [];
    await new PostgresDrFailoverStore(mockConnection(capture)).listRecent(5);
    expect(capture.some((c) => c.sql.includes("set_config"))).toBe(false);
  });

  it("refuses a tenantId that is not a plausible RLS context, before issuing anything", async () => {
    // The record schema's `uuid()` catches this first on every path the store exposes, so this is
    // defence in depth rather than the only guard — but the id is interpolated into no SQL and
    // bound as a parameter, and a scope wrapper that trusted its argument would be the one place
    // that stopped being true.
    const capture: Captured[] = [];
    await expect(
      scopedWrite(mockConnection(capture), "'; DROP TABLE meta.tenants --", async () => undefined),
    ).rejects.toThrow(/invalid tenantId/);
    expect(capture).toEqual([]);
  });

  it("claims the elevation transaction-locally, never session-wide", () => {
    // `set_config(..., true)` — the third argument is `is_local`. A session-wide `SET` on a pooled
    // connection would hand the elevation to whoever is served next.
    expect(SET_PLATFORM_RECORD_WRITE_SQL).toContain(", true)");
    expect(SET_PLATFORM_RECORD_WRITE_SQL.startsWith("SET ")).toBe(false);
  });

  it("is not the config grant, and not the cross-tenant read grant", () => {
    // A DR drill scheduler that could also flip `gateway.strict_jwt_aud` is an authentication
    // bypass, which is why recording what the deployment did and changing what it does are two
    // grants rather than one.
    expect(SET_PLATFORM_RECORD_WRITE_SQL).not.toContain("app.platform_config_write");
    expect(SET_PLATFORM_RECORD_WRITE_SQL).not.toContain("app.platform_key_write");
    expect(SET_PLATFORM_RECORD_WRITE_SQL).not.toContain("app.platform_audit");
  });
});
