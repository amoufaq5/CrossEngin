import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { WorkflowInstanceIdResolver } from "./id-mapping.js";
import { PostgresSignalStore, type SignalProjection } from "./signal-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const INSTANCE_UUID = "00000000-0000-4000-8000-000000000123";

function fixtureSignal(overrides: Partial<SignalProjection> = {}): SignalProjection {
  return {
    id: "wfs_sig00001",
    instanceId: "wfi_inst0001",
    tenantId: TENANT,
    signalName: "external.approve",
    correlationKey: "po-1",
    status: "matched_to_instance",
    receivedAt: "2026-05-16T12:00:00.000Z",
    matchedAt: "2026-05-16T12:00:00.000Z",
    consumedAt: null,
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

describe("PostgresSignalStore.upsert", () => {
  it("INSERTs with the resolved instance UUID", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresSignalStore({ conn, instanceResolver: resolver });
    await store.upsert(fixtureSignal());
    expect(capture[0]?.sql).toContain("INSERT INTO meta.workflow_signals");
    expect(capture[0]?.params?.[0]).toBe("wfs_sig00001");
    expect(capture[0]?.params?.[1]).toBe(INSTANCE_UUID);
    expect(capture[0]?.params?.[3]).toBe("external.approve");
  });

  it("permits an unattached signal (instanceId = null)", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    const store = new PostgresSignalStore({ conn, instanceResolver: resolver });
    await store.upsert(fixtureSignal({ instanceId: null, status: "received" }));
    expect(capture[0]?.params?.[1]).toBeNull();
  });

  it("transitions matched → consumed via UPSERT", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresSignalStore({ conn, instanceResolver: resolver });
    await store.upsert(
      fixtureSignal({ status: "consumed", consumedAt: "2026-05-16T12:00:05.000Z" }),
    );
    expect(capture[0]?.sql).toContain("ON CONFLICT (signal_id) DO UPDATE");
    expect(capture[0]?.params?.[5]).toBe("consumed");
    expect(capture[0]?.params?.[8]).toBe("2026-05-16T12:00:05.000Z");
  });

  it("upsertMany processes all signals", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresSignalStore({ conn, instanceResolver: resolver });
    await store.upsertMany([
      fixtureSignal({ id: "wfs_a" }),
      fixtureSignal({ id: "wfs_b" }),
      fixtureSignal({ id: "wfs_c" }),
    ]);
    expect(capture).toHaveLength(3);
  });
});
