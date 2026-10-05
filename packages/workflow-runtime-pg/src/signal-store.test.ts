import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { WorkflowInstanceIdResolver } from "./id-mapping.js";
import {
  PostgresSignalDeduplicator,
  PostgresSignalStore,
  SIGNAL_IDEMPOTENCY_CONSTRAINT,
  SignalIdempotencyConflict,
  type SignalProjection,
} from "./signal-store.js";

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
    idempotencyKey: null,
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
  rows: readonly Record<string, unknown>[] = [],
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      if (capture !== undefined) capture.push({ sql, params });
      return { rows: [...rows], rowCount: rows.length };
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

/** A node-postgres unique violation, as the driver shapes it. */
function uniqueViolation(constraint: string): Error & { code: string; constraint: string } {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: "23505",
    constraint,
  });
}

function throwingConnection(err: unknown): PgConnection {
  return {
    query: vi.fn(async () => {
      throw err;
    }) as unknown as PgConnection["query"],
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
    expect(capture[0]?.params?.[9]).toBe("consumed");
    expect(capture[0]?.params?.[12]).toBe("2026-05-16T12:00:05.000Z");
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
        idempotencyKey: "evt-42",
        sourcePrincipalId: "00000000-0000-4000-8000-0000000000aa",
      }),
    );
    const sql = capture[0]?.sql ?? "";
    expect(sql).toContain("delivery_guarantee");
    expect(sql).toContain("source_system");
    expect(sql).toContain("source_principal_id");
    expect(capture[0]?.params?.[5]).toBe("exactly_once_idempotent");
    expect(capture[0]?.params?.[7]).toBe("procurement-gateway");
    expect(capture[0]?.params?.[8]).toBe("00000000-0000-4000-8000-0000000000aa");
  });

  it("binds idempotency_key, the column the table's unique index is on", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresSignalStore({ conn, instanceResolver: resolver });
    await store.upsert(fixtureSignal({ idempotencyKey: "evt-42" }));
    expect(capture[0]?.sql).toContain("idempotency_key");
    expect(capture[0]?.params?.[6]).toBe("evt-42");
  });

  it("binds a null idempotency_key rather than omitting the column", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresSignalStore({ conn, instanceResolver: resolver });
    await store.upsert(fixtureSignal({ idempotencyKey: null }));
    expect(capture[0]?.params?.[6]).toBeNull();
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
    await store.upsert(fixtureSignal({ idempotencyKey: "evt-42" }));
    const doUpdate = (capture[0]?.sql ?? "").split("DO UPDATE")[1] ?? "";
    expect(doUpdate).not.toContain("delivery_guarantee");
    expect(doUpdate).not.toContain("source_system");
    expect(doUpdate).not.toContain("source_principal_id");
    // The key is receipt provenance like the rest, and the row it belongs to is the one that
    // already holds it — rewriting it would let a re-projection move a delivery's identity.
    expect(doUpdate).not.toContain("idempotency_key");
  });

  it("translates a unique violation on the idempotency index into SignalIdempotencyConflict", async () => {
    const conn = throwingConnection(uniqueViolation(SIGNAL_IDEMPOTENCY_CONSTRAINT));
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresSignalStore({ conn, instanceResolver: resolver });
    await expect(
      store.upsert(fixtureSignal({ idempotencyKey: "evt-42" })),
    ).rejects.toThrow(SignalIdempotencyConflict);
  });

  it("re-raises a unique violation on any other constraint unchanged", async () => {
    const conn = throwingConnection(uniqueViolation("workflow_signals_signal_id_key"));
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresSignalStore({ conn, instanceResolver: resolver });
    const err = await store.upsert(fixtureSignal({ idempotencyKey: "evt-42" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe("SignalIdempotencyConflict");
  });

  it("does not claim an idempotency conflict for a keyless signal", async () => {
    const conn = throwingConnection(uniqueViolation(SIGNAL_IDEMPOTENCY_CONSTRAINT));
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresSignalStore({ conn, instanceResolver: resolver });
    const err = await store.upsert(fixtureSignal({ idempotencyKey: null })).catch((e: unknown) => e);
    expect((err as Error).name).not.toBe("SignalIdempotencyConflict");
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

describe("PostgresSignalDeduplicator", () => {
  it("answers null for an unseen key", async () => {
    const dedup = new PostgresSignalDeduplicator(mockConnection(undefined, []));
    expect(
      await dedup.lookup({ tenantId: TENANT, signalName: "external.approve", idempotencyKey: "evt-1" }),
    ).toBeNull();
  });

  it("binds the three columns of the unique key", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const dedup = new PostgresSignalDeduplicator(mockConnection(capture, []));
    await dedup.lookup({ tenantId: TENANT, signalName: "external.approve", idempotencyKey: "evt-1" });
    const sql = capture[0]?.sql ?? "";
    expect(sql).toContain("s.tenant_id = $1");
    expect(sql).toContain("s.signal_name = $2");
    expect(sql).toContain("s.idempotency_key = $3");
    expect(capture[0]?.params).toEqual([TENANT, "external.approve", "evt-1"]);
  });

  it("returns every prior delivery, with the textual instance id", async () => {
    const dedup = new PostgresSignalDeduplicator(
      mockConnection(undefined, [
        { signal_id: "wfs_one", instance_id: "wfi_a" },
        { signal_id: "wfs_two", instance_id: "wfi_b" },
      ]),
    );
    expect(
      await dedup.lookup({ tenantId: TENANT, signalName: "external.approve", idempotencyKey: "evt-1" }),
    ).toEqual([
      { instanceId: "wfi_a", signalId: "wfs_one" },
      { instanceId: "wfi_b", signalId: "wfs_two" },
    ]);
  });

  it("reports a key seen but matched to no instance as an empty delivery list, not as unseen", async () => {
    const dedup = new PostgresSignalDeduplicator(
      mockConnection(undefined, [{ signal_id: "wfs_one", instance_id: null }]),
    );
    expect(
      await dedup.lookup({ tenantId: TENANT, signalName: "external.approve", idempotencyKey: "evt-1" }),
    ).toEqual([]);
  });

  it("remembers nothing: the signal rows are the ledger", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const dedup = new PostgresSignalDeduplicator(mockConnection(capture, []));
    await dedup.remember();
    expect(capture).toHaveLength(0);
  });
});
