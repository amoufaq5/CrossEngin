import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresSloEvaluationStore } from "./evaluation-store.js";
import {
  SET_PLATFORM_RECORD_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
  scopedWrite,
  type SloEvaluationRecord,
} from "./records.js";

/** `{sql, params}` as the offline fakes in this package record it. */
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

function fixture(overrides: Partial<SloEvaluationRecord> = {}): SloEvaluationRecord {
  return {
    evaluationId: "sloe_auto00000001",
    tenantId: TENANT,
    sloId: "orders-availability",
    surface: "POST /v1/orders",
    breached: true,
    worstSeverity: "sev2",
    worstThresholdId: "fast-burn",
    target: 0.99,
    evaluations: [{ threshold: "fast-burn" }],
    evaluatedAt: "2026-06-02T12:00:00.000Z",
    ...overrides,
  };
}

describe("PostgresSloEvaluationStore.record", () => {
  it("issues an INSERT ... ON CONFLICT DO NOTHING", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEvaluationStore(mockConnection(capture));
    await store.record(fixture());
    // The session setting, then the write. Nothing else.
    expect(capture).toHaveLength(2);
    expect(written(capture).sql).toContain("INSERT INTO meta.slo_evaluations");
    expect(written(capture).sql).toContain("ON CONFLICT (evaluation_id) DO NOTHING");
  });

  it("serializes evaluations to a JSON string", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEvaluationStore(mockConnection(capture));
    await store.record(fixture());
    const evalParam = written(capture).params?.[8] as string;
    expect(typeof evalParam).toBe("string");
    expect(JSON.parse(evalParam)).toHaveLength(1);
  });

  it("validates the record before insert", async () => {
    const store = new PostgresSloEvaluationStore(mockConnection());
    await expect(store.record(fixture({ target: 2 }))).rejects.toThrow();
  });

  it("threads tenant + breached as bind params", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEvaluationStore(mockConnection(capture));
    await store.record(fixture());
    expect(written(capture).params?.[1]).toBe(TENANT);
    expect(written(capture).params?.[4]).toBe(true);
  });
});

describe("PostgresSloEvaluationStore.countBreachesSince", () => {
  it("parses COUNT(*) from the row", async () => {
    const store = new PostgresSloEvaluationStore(
      mockConnection(undefined, { rows: [{ count: "7" }], rowCount: 1 }),
    );
    expect(await store.countBreachesSince("orders-availability", new Date())).toBe(7);
  });

  it("returns 0 with no rows", async () => {
    const store = new PostgresSloEvaluationStore(
      mockConnection(undefined, { rows: [], rowCount: 0 }),
    );
    expect(await store.countBreachesSince("x", new Date())).toBe(0);
  });
});

describe("the platform write arm", () => {
  it("claims app.platform_record_write before a platform-scope write", async () => {
    // These stores used to set nothing at all, which worked only because the deployment connects as
    // the table's owner and an owner bypasses its policies. As a non-owner the one `ALL`-scope
    // policy admitted a platform row unconditionally — the defect — and refused a *tenant* row
    // outright, since with no context `current_setting('app.current_tenant_id', true)` answers NULL
    // and the comparison is never true. Both arms are set now, for those two separate reasons.
    //
    // An SLO surface is never a tenant (ADR-0327), so a platform-scope evaluation is the ordinary
    // case here rather than an edge one.
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresSloEvaluationStore(mockConnection(capture));
    await store.record(fixture({ tenantId: null }));
    expect(capture[0]?.sql).toBe(SET_PLATFORM_RECORD_WRITE_SQL);
    expect(capture[0]?.sql).toContain("app.platform_record_write");
    expect(capture[1]?.sql).toContain("INSERT INTO meta.slo_evaluations");
  });

  it("claims the tenant context instead for a tenant-scope write, never both", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await new PostgresSloEvaluationStore(mockConnection(capture)).record(fixture());
    const settings = capture.filter((c) => c.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    expect(settings[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(settings[0]?.params).toEqual([TENANT]);
  });

  it("claims nothing at all on a read, which the split left unchanged", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await new PostgresSloEvaluationStore(mockConnection(capture)).countBreachesSince(
      "orders-availability",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(capture.some((c) => c.sql.includes("set_config"))).toBe(false);
  });

  it("rejects a tenantId that is not a plausible RLS context, having issued nothing", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await expect(
      scopedWrite(mockConnection(capture), "'; DROP TABLE meta.tenants --", async () => undefined),
    ).rejects.toThrow(/invalid tenantId/);
    expect(capture).toEqual([]);
  });

  it("claims the elevation transaction-locally, never session-wide", () => {
    expect(SET_PLATFORM_RECORD_WRITE_SQL).toBe(
      "SELECT set_config('app.platform_record_write', 'on', true)",
    );
  });

  it("is neither the config grant, the key grant, nor the cross-tenant read grant", () => {
    // Recording what the deployment observed and changing what it does are separate privileges: a
    // breach evaluator that could also flip a platform-wide feature flag is an authentication
    // bypass away from the thing it was meant to measure.
    for (const other of [
      "app.platform_config_write",
      "app.platform_key_write",
      "app.platform_audit",
    ]) {
      expect(SET_PLATFORM_RECORD_WRITE_SQL).not.toContain(other);
    }
  });
});

describe("the scope predicate a read carries beside RLS", () => {
  const SINCE = new Date("2026-01-01T00:00:00.000Z");

  it("asks for the platform scope by name, not by the absence of a predicate", async () => {
    const capture: Captured[] = [];
    await new PostgresSloEvaluationStore(mockConnection(capture)).countBreachesSince(
      "orders-availability",
      SINCE,
    );
    const read = written(capture);
    expect(read.sql).toContain("tenant_id IS NULL");
    expect(read.sql).not.toContain("tenant_id = $");
    expect(read.params).toEqual(["orders-availability", SINCE.toISOString()]);
  });

  it("branches to equality for a tenant, binding the id rather than interpolating it", async () => {
    const capture: Captured[] = [];
    await new PostgresSloEvaluationStore(mockConnection(capture)).countBreachesSince(
      "orders-availability",
      SINCE,
      TENANT,
    );
    const read = written(capture);
    expect(read.sql).toContain("tenant_id = $3");
    expect(read.sql).not.toContain("tenant_id IS NULL");
    // Deliberately not `IS NOT DISTINCT FROM`: it matches NULL to NULL and would give one code
    // path, but ADR-0331 measured it unindexable — 16 ms sequential scan where equality is a
    // 0.09 ms index scan on 45k rows.
    expect(read.sql).not.toContain("IS NOT DISTINCT FROM");
    expect(read.params).toEqual(["orders-availability", SINCE.toISOString(), TENANT]);
  });

  it("sets the tenant's RLS context too, so the predicate is beside RLS and not instead of it", async () => {
    const capture: Captured[] = [];
    await new PostgresSloEvaluationStore(mockConnection(capture)).countBreachesSince(
      "orders-availability",
      SINCE,
      TENANT,
    );
    const settings = capture.filter((c) => c.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    expect(settings[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(settings[0]?.params).toEqual([TENANT]);
  });

  it("claims no write elevation on a platform read, which needs no grant", async () => {
    const capture: Captured[] = [];
    await new PostgresSloEvaluationStore(mockConnection(capture)).countBreachesSince(
      "orders-availability",
      SINCE,
    );
    expect(capture.some((c) => c.sql.includes("set_config"))).toBe(false);
  });

  it("refuses a tenantId that is not a plausible RLS context before issuing anything", async () => {
    const capture: Captured[] = [];
    await expect(
      new PostgresSloEvaluationStore(mockConnection(capture)).countBreachesSince(
        "orders-availability",
        SINCE,
        "'; DROP TABLE meta.tenants --",
      ),
    ).rejects.toThrow(/invalid tenantId/);
    expect(capture).toEqual([]);
  });
});
