import { META_WORKFLOW_TIMERS } from "@crossengin/kernel/bootstrap";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { WorkflowInstanceIdResolver } from "./id-mapping.js";
import {
  insertColumnList,
  missingRequiredColumns,
  requiredColumnNames,
} from "./required-columns.js";
import { PostgresTimerStore, type TimerProjection } from "./timer-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const INSTANCE_UUID = "00000000-0000-4000-8000-000000000123";

function fixtureTimer(overrides: Partial<TimerProjection> = {}): TimerProjection {
  return {
    id: "wft_tim00001",
    instanceId: "wfi_inst0001",
    tenantId: TENANT,
    timerName: "approval_deadline",
    kind: "relative_after",
    status: "scheduled",
    scheduledAt: "2026-05-16T12:00:00.000Z",
    fireAt: "2026-05-17T12:00:00.000Z",
    timezone: "UTC",
    cronExpression: null,
    relativeSeconds: 86_400,
    transitionToTrigger: "expire",
    firedAt: null,
    cancelledAt: null,
    fireCount: 0,
    nextFireAt: null,
    ...overrides,
  };
}

function mockConnection(
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      if (capture !== undefined) capture.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

/** The bound parameter for a named column, found by its position in the recorded column list. */
function boundValue(
  entry: { sql: string; params: readonly unknown[] | undefined },
  column: string,
): unknown {
  const index = insertColumnList(entry.sql).indexOf(column);
  expect(index).toBeGreaterThanOrEqual(0);
  return entry.params?.[index];
}

async function captureUpsert(
  projection: TimerProjection,
): Promise<{ sql: string; params: readonly unknown[] | undefined }> {
  const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  const conn = mockConnection(capture);
  const resolver = new WorkflowInstanceIdResolver(conn);
  resolver.register("wfi_inst0001", INSTANCE_UUID);
  const store = new PostgresTimerStore({ conn, instanceResolver: resolver });
  await store.upsert(projection);
  return capture[0]!;
}

/**
 * The durable half of ADR-0332's fix for this store, and the one assertion the old suite could not
 * have made. Five tests passed against a statement that omitted `kind` — NOT NULL with no default —
 * because a fake `PgConnection` sees only the SQL's shape. This asks the catalog instead.
 */
describe("PostgresTimerStore — catalog-derived column coverage", () => {
  it("names every required column of META_WORKFLOW_TIMERS", async () => {
    const insert = await captureUpsert(fixtureTimer());
    expect(missingRequiredColumns(META_WORKFLOW_TIMERS, insert.sql)).toEqual([]);
  });

  it("required columns are exactly the notNull ones with no default", () => {
    expect([...requiredColumnNames(META_WORKFLOW_TIMERS)].sort()).toEqual([
      "fire_at",
      "instance_id",
      "kind",
      "scheduled_at",
      "status",
      "tenant_id",
      "timer_id",
      "timer_name",
    ]);
  });

  it("names `kind`, the column whose omission threw against every real database", async () => {
    const insert = await captureUpsert(fixtureTimer());
    expect(insertColumnList(insert.sql)).toContain("kind");
  });

  it("binds one parameter per named column", async () => {
    const insert = await captureUpsert(fixtureTimer());
    expect(insert.params).toHaveLength(insertColumnList(insert.sql).length);
  });

  it("names no column the catalog does not declare", async () => {
    const insert = await captureUpsert(fixtureTimer());
    const declared = new Set(META_WORKFLOW_TIMERS.columns.map((c) => c.name));
    expect(insertColumnList(insert.sql).filter((c) => !declared.has(c))).toEqual([]);
  });
});

describe("PostgresTimerStore.upsert", () => {
  it("INSERTs with the resolved instance UUID", async () => {
    const insert = await captureUpsert(fixtureTimer());
    expect(insert.sql).toContain("INSERT INTO meta.workflow_timers");
    expect(boundValue(insert, "timer_id")).toBe("wft_tim00001");
    expect(boundValue(insert, "instance_id")).toBe(INSTANCE_UUID);
    expect(boundValue(insert, "timer_name")).toBe("approval_deadline");
  });

  it("binds the resolved kind and its parameters together", async () => {
    const insert = await captureUpsert(
      fixtureTimer({ kind: "cron_schedule", cronExpression: "0 9 * * *", relativeSeconds: null }),
    );
    expect(boundValue(insert, "kind")).toBe("cron_schedule");
    expect(boundValue(insert, "cron_expression")).toBe("0 9 * * *");
    expect(boundValue(insert, "relative_seconds")).toBeNull();
  });

  it("binds the transition its firing triggers, a column nothing had ever written", async () => {
    const insert = await captureUpsert(fixtureTimer());
    expect(boundValue(insert, "transition_to_trigger")).toBe("expire");
  });

  it("binds null when no single transition owns the timer", async () => {
    const insert = await captureUpsert(fixtureTimer({ transitionToTrigger: null }));
    expect(boundValue(insert, "transition_to_trigger")).toBeNull();
  });

  it("binds the declared timezone rather than relying on the column default", async () => {
    const insert = await captureUpsert(
      fixtureTimer({ kind: "business_hours", relativeSeconds: null, timezone: "Asia/Tokyo" }),
    );
    expect(boundValue(insert, "timezone")).toBe("Asia/Tokyo");
  });

  it("ON CONFLICT updates status + firedAt + cancelledAt", async () => {
    const insert = await captureUpsert(
      fixtureTimer({ status: "fired", firedAt: "2026-05-17T12:00:00.000Z", fireCount: 1 }),
    );
    expect(insert.sql).toContain("ON CONFLICT (timer_id) DO UPDATE");
    expect(boundValue(insert, "status")).toBe("fired");
    expect(boundValue(insert, "fired_at")).toBe("2026-05-17T12:00:00.000Z");
  });

  it("ON CONFLICT updates fire_count, so a fired timer stops claiming zero fires", async () => {
    const insert = await captureUpsert(fixtureTimer({ status: "fired", fireCount: 1 }));
    expect(insert.sql).toContain("fire_count = EXCLUDED.fire_count");
    expect(boundValue(insert, "fire_count")).toBe(1);
  });

  it("leaves the definition-resolved columns out of the DO UPDATE set", async () => {
    const insert = await captureUpsert(fixtureTimer());
    const doUpdate = insert.sql.slice(insert.sql.indexOf("DO UPDATE"));
    for (const column of ["kind", "timezone", "cron_expression", "relative_seconds"]) {
      expect(doUpdate).not.toContain(`${column} = EXCLUDED`);
    }
  });

  it("threads cancelledAt when cancelled", async () => {
    const insert = await captureUpsert(
      fixtureTimer({ status: "cancelled", cancelledAt: "2026-05-17T11:00:00.000Z" }),
    );
    expect(boundValue(insert, "cancelled_at")).toBe("2026-05-17T11:00:00.000Z");
  });

  it("rejects when instance is not resolvable", async () => {
    const conn = mockConnection();
    const resolver = new WorkflowInstanceIdResolver(conn);
    const store = new PostgresTimerStore({ conn, instanceResolver: resolver });
    await expect(store.upsert(fixtureTimer({ instanceId: "wfi_unknown01" }))).rejects.toThrow(
      /workflow instance not found/,
    );
  });

  it("upsertMany processes all timers", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresTimerStore({ conn, instanceResolver: resolver });
    await store.upsertMany([fixtureTimer({ id: "wft_a" }), fixtureTimer({ id: "wft_b" })]);
    expect(capture).toHaveLength(2);
  });

  it("upsertMany with no timers issues no statement", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    const store = new PostgresTimerStore({ conn, instanceResolver: resolver });
    await store.upsertMany([]);
    expect(capture).toEqual([]);
  });
});

describe("PostgresTimerStore.upsert — a recurring timer's next occurrence", () => {
  it("names next_fire_at in the INSERT, a catalog column nothing had ever written", async () => {
    const insert = await captureUpsert(fixtureTimer());
    expect(insertColumnList(insert.sql)).toContain("next_fire_at");
  });

  it("binds the next occurrence for a fired cron timer", async () => {
    const insert = await captureUpsert(
      fixtureTimer({
        kind: "cron_schedule",
        cronExpression: "0 2 * * *",
        relativeSeconds: null,
        status: "fired",
        firedAt: "2026-05-17T02:00:00.000Z",
        fireCount: 1,
        nextFireAt: "2026-05-18T02:00:00.000Z",
      }),
    );
    expect(boundValue(insert, "next_fire_at")).toBe("2026-05-18T02:00:00.000Z");
    expect(boundValue(insert, "fire_count")).toBe(1);
  });

  it("binds null for a kind that fires once", async () => {
    const insert = await captureUpsert(fixtureTimer());
    expect(boundValue(insert, "next_fire_at")).toBeNull();
  });

  it("updates next_fire_at and scheduled_at on conflict, so a re-arm moves the row", async () => {
    const insert = await captureUpsert(fixtureTimer());
    expect(insert.sql).toContain("next_fire_at = EXCLUDED.next_fire_at");
    expect(insert.sql).toContain("scheduled_at = EXCLUDED.scheduled_at");
  });

  it("releases the claim exactly when the write records a fire the row had not", async () => {
    // Keyed on `fire_count` advancing, not on `EXCLUDED.status = 'scheduled'`: `ProjectingEventLog`
    // re-projects every timer on every append, so a status-keyed clause would clear a live claim
    // another worker holds mid-fire whenever an unrelated event landed on the instance.
    const insert = await captureUpsert(fixtureTimer());
    expect(insert.sql).toMatch(
      /claimed_by = CASE\s+WHEN EXCLUDED\.fire_count > meta\.workflow_timers\.fire_count THEN NULL/,
    );
    expect(insert.sql).toMatch(
      /claim_expires_at = CASE\s+WHEN EXCLUDED\.fire_count > meta\.workflow_timers\.fire_count THEN NULL/,
    );
    expect(insert.sql).not.toContain("EXCLUDED.status = 'scheduled'");
  });

  it("does not clear the claim unconditionally", async () => {
    const insert = await captureUpsert(fixtureTimer());
    expect(insert.sql).not.toMatch(/claimed_by = NULL/);
  });
});
