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
    deliveryGuarantee: "at_least_once",
    sourceSystem: "procurement-gateway",
    sourcePrincipalId: null,
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
    expect(capture[0]?.params?.[8]).toBe("consumed");
    expect(capture[0]?.params?.[11]).toBe("2026-05-16T12:00:05.000Z");
  });

  it("binds the NOT NULL provenance columns the table requires", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresSignalStore({ conn, instanceResolver: resolver });
    await store.upsert(
      fixtureSignal({
        deliveryGuarantee: "exactly_once_idempotent",
        sourcePrincipalId: "00000000-0000-4000-8000-0000000000aa",
      }),
    );
    const sql = capture[0]?.sql ?? "";
    expect(sql).toContain("delivery_guarantee");
    expect(sql).toContain("source_system");
    expect(sql).toContain("source_principal_id");
    expect(capture[0]?.params?.[5]).toBe("exactly_once_idempotent");
    expect(capture[0]?.params?.[6]).toBe("procurement-gateway");
    expect(capture[0]?.params?.[7]).toBe("00000000-0000-4000-8000-0000000000aa");
  });

  it("every column named is bound, and every binding named", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresSignalStore({ conn, instanceResolver: resolver });
    await store.upsert(fixtureSignal());
    const sql = capture[0]?.sql ?? "";
    const columnList = /INSERT INTO meta\.workflow_signals \(([\s\S]*?)\)\s*VALUES/.exec(sql)?.[1];
    const placeholders = /VALUES \(([^)]*)\)/.exec(sql)?.[1];
    const columns = (columnList ?? "").split(",").map((c) => c.trim()).filter((c) => c.length > 0);
    const bound = (placeholders ?? "").split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    expect(columns).toHaveLength(bound.length);
    expect(columns).toHaveLength(capture[0]?.params?.length ?? 0);
    expect(bound).toEqual(columns.map((_, i) => `$${i + 1}`));
  });

  it("does not rewrite provenance on the conflict path", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresSignalStore({ conn, instanceResolver: resolver });
    await store.upsert(fixtureSignal());
    const doUpdate = (capture[0]?.sql ?? "").split("DO UPDATE")[1] ?? "";
    expect(doUpdate).not.toContain("delivery_guarantee");
    expect(doUpdate).not.toContain("source_system");
    expect(doUpdate).not.toContain("source_principal_id");
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
