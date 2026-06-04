import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { WorkflowInstanceIdResolver } from "./id-mapping.js";
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
    firedAt: null,
    cancelledAt: null,
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

describe("PostgresTimerStore.upsert", () => {
  it("INSERTs with the resolved instance UUID", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresTimerStore({ conn, instanceResolver: resolver });
    await store.upsert(fixtureTimer());
    expect(capture[0]?.sql).toContain("INSERT INTO meta.workflow_timers");
    expect(capture[0]?.params?.[0]).toBe("wft_tim00001");
    expect(capture[0]?.params?.[1]).toBe(INSTANCE_UUID);
    expect(capture[0]?.params?.[3]).toBe("approval_deadline");
  });

  it("ON CONFLICT updates status + firedAt + cancelledAt", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresTimerStore({ conn, instanceResolver: resolver });
    await store.upsert(
      fixtureTimer({ status: "fired", firedAt: "2026-05-17T12:00:00.000Z" }),
    );
    expect(capture[0]?.sql).toContain("ON CONFLICT (timer_id) DO UPDATE");
    expect(capture[0]?.params?.[5]).toBe("fired");
    expect(capture[0]?.params?.[8]).toBe("2026-05-17T12:00:00.000Z");
  });

  it("threads cancelledAt when cancelled", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresTimerStore({ conn, instanceResolver: resolver });
    await store.upsert(
      fixtureTimer({ status: "cancelled", cancelledAt: "2026-05-17T11:00:00.000Z" }),
    );
    expect(capture[0]?.params?.[9]).toBe("2026-05-17T11:00:00.000Z");
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
    await store.upsertMany([
      fixtureTimer({ id: "wft_a" }),
      fixtureTimer({ id: "wft_b" }),
    ]);
    expect(capture).toHaveLength(2);
  });
});
