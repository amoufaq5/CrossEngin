import type { IdempotencyRecord } from "@crossengin/api-gateway";
import type { IdempotencyReservation } from "@crossengin/api-gateway-runtime";
import { describe, expect, it, vi } from "vitest";

import type { IntervalHandle, IntervalScheduler } from "./jwks.js";
import {
  DEFAULT_IDEMPOTENCY_PRUNE_MS,
  IDEMPOTENCY_GUARANTEE,
  IdempotencyPruneScheduler,
  ReportingIdempotencyStore,
  pruneIdempotencyRecords,
} from "./gateway-idempotency.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function record(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  return {
    id: "idem_abcdefghijklmn",
    tenantId: TENANT,
    operationId: "tenants.delete",
    method: "DELETE",
    idempotencyKey: "key-delete-1",
    requestHashSha256: "a".repeat(64),
    principalId: null,
    receivedAt: "2026-05-16T12:00:00.000Z",
    expiresAt: "2026-05-17T12:00:00.000Z",
    status: "completed_success",
    responseStatus: 200,
    responseSha256: null,
    responseStorageUri: null,
    completedAt: "2026-05-16T12:00:01.000Z",
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

function innerStore(overrides: {
  get?: () => Promise<IdempotencyRecord | null>;
  put?: () => Promise<void>;
  update?: () => Promise<IdempotencyRecord>;
  reserve?: () => Promise<IdempotencyReservation>;
  complete?: () => Promise<void>;
  release?: () => Promise<void>;
} = {}) {
  return {
    get: vi.fn(overrides.get ?? (async () => null)),
    put: vi.fn(overrides.put ?? (async () => undefined)),
    update: vi.fn(overrides.update ?? (async () => record())),
    reserve: vi.fn(overrides.reserve ?? (async (): Promise<IdempotencyReservation> => ({ reserved: true }))),
    complete: vi.fn(overrides.complete ?? (async () => undefined)),
    release: vi.fn(overrides.release ?? (async () => undefined)),
  };
}

describe("ReportingIdempotencyStore.get — fail closed", () => {
  it("delegates and returns the record", async () => {
    const inner = innerStore({ get: async () => record() });
    const store = new ReportingIdempotencyStore(inner);
    expect(await store.get({ tenantId: TENANT, key: "key-delete-1" })).toMatchObject({
      idempotencyKey: "key-delete-1",
    });
  });

  /**
   * The load-bearing half. `get` runs before the handler, so a failure means the gateway cannot
   * tell a replay from a first attempt — and the fail-closed answer is to refuse the request, not
   * to execute it and hope. Nothing has happened yet, so refusing costs nothing.
   */
  it("propagates a read failure rather than answering null", async () => {
    const inner = innerStore({
      get: async () => {
        throw new Error("connection terminated");
      },
    });
    const store = new ReportingIdempotencyStore(inner);
    await expect(store.get({ tenantId: TENANT, key: "k" })).rejects.toThrow(
      /connection terminated/,
    );
  });

  it("does not count a read failure as a persist failure", async () => {
    const inner = innerStore({
      get: async () => {
        throw new Error("down");
      },
    });
    const store = new ReportingIdempotencyStore(inner);
    await expect(store.get({ tenantId: TENANT, key: "k" })).rejects.toThrow();
    expect(store.report()).toMatchObject({ persisted: 0, failed: 0 });
  });
});

describe("ReportingIdempotencyStore.put — report, never throw", () => {
  it("counts a successful persist", async () => {
    const inner = innerStore();
    const store = new ReportingIdempotencyStore(inner);
    await store.put({ tenantId: TENANT, record: record() });
    expect(inner.put).toHaveBeenCalledTimes(1);
    expect(store.report()).toMatchObject({ persisted: 1, failed: 0, firstFailure: null });
  });

  /**
   * The handler has already committed by the time `put` runs. Throwing turns a 2xx into a 500, the
   * client retries, and the retry re-executes — with no record to stop it, because the record is
   * the thing that failed. So a throw here *causes* the double execution it would be preventing.
   */
  it("swallows a persist failure so a committed mutation is not reported as a 500", async () => {
    const inner = innerStore({
      put: async () => {
        throw new Error("42501 new row violates row-level security policy");
      },
    });
    const store = new ReportingIdempotencyStore(inner);
    await expect(store.put({ tenantId: TENANT, record: record() })).resolves.toBeUndefined();
  });

  it("counts the failure and keeps the first message", async () => {
    let n = 0;
    const inner = innerStore({
      put: async () => {
        n += 1;
        throw new Error(`failure ${n.toString()}`);
      },
    });
    const store = new ReportingIdempotencyStore(inner);
    await store.put({ tenantId: TENANT, record: record() });
    await store.put({ tenantId: TENANT, record: record() });
    expect(store.report()).toMatchObject({ persisted: 0, failed: 2, firstFailure: "failure 1" });
  });

  it("routes the failure to onPersistError with the tenant and key, never the record", async () => {
    const onPersistError = vi.fn();
    const inner = innerStore({
      put: async () => {
        throw new Error("down");
      },
    });
    const store = new ReportingIdempotencyStore(inner, { onPersistError });
    await store.put({ tenantId: TENANT, record: record() });
    expect(onPersistError).toHaveBeenCalledTimes(1);
    expect(onPersistError.mock.calls[0]?.[1]).toEqual({ tenantId: TENANT, key: "key-delete-1", operation: "put" });
  });

  it("mixes successes and failures in one report", async () => {
    let fail = true;
    const inner = innerStore({
      put: async () => {
        fail = !fail;
        if (fail) throw new Error("intermittent");
      },
    });
    const store = new ReportingIdempotencyStore(inner);
    await store.put({ tenantId: TENANT, record: record() });
    await store.put({ tenantId: TENANT, record: record() });
    await store.put({ tenantId: TENANT, record: record() });
    const r = store.report();
    expect(r.persisted + r.failed).toBe(3);
    expect(r.failed).toBeGreaterThan(0);
  });
});

describe("ReportingIdempotencyStore.update", () => {
  it("delegates unchanged", async () => {
    const inner = innerStore();
    const store = new ReportingIdempotencyStore(inner);
    await store.update({ tenantId: TENANT, key: "k", mutate: (r) => r });
    expect(inner.update).toHaveBeenCalledTimes(1);
  });

  it("propagates, because nothing on the request path calls it", async () => {
    const inner = innerStore({
      update: async () => {
        throw new Error("no idempotency record");
      },
    });
    const store = new ReportingIdempotencyStore(inner);
    await expect(
      store.update({ tenantId: TENANT, key: "k", mutate: (r) => r }),
    ).rejects.toThrow(/no idempotency record/);
    expect(store.report().failed).toBe(0);
  });
});

describe("ReportingIdempotencyStore — reserve, complete and release", () => {
  it("propagates a reservation failure, because a request with no reservation must not run", async () => {
    const store = new ReportingIdempotencyStore(
      innerStore({
        reserve: async () => {
          throw new Error("statement timeout");
        },
      }),
    );
    await expect(store.reserve({ tenantId: TENANT, record: record({ status: "in_progress" }) })).rejects.toThrow(
      /statement timeout/,
    );
  });

  it("lets a tenant with no meta.tenants row through unguarded and reported, rather than 500ing it", async () => {
    // Measured live: the reservation's foreign key refused a keyed POST from an unprovisioned
    // api-key tenant, and propagating that turned the tenant-status gate's named 403 into a 500.
    const reported: string[] = [];
    const store = new ReportingIdempotencyStore(
      innerStore({
        reserve: async () => {
          throw Object.assign(new Error("violates foreign key constraint"), { code: "23503" });
        },
      }),
      { onPersistError: (_err, where) => reported.push(where.key) },
    );
    const r = record({ status: "in_progress" });
    await expect(store.reserve({ tenantId: TENANT, record: r })).resolves.toEqual({ reserved: true });
    expect(reported).toEqual([r.idempotencyKey]);
  });

  it("still propagates any other reservation failure", async () => {
    const store = new ReportingIdempotencyStore(
      innerStore({
        reserve: async () => {
          throw Object.assign(new Error("connection reset"), { code: "08006" });
        },
      }),
    );
    await expect(store.reserve({ tenantId: TENANT, record: record({ status: "in_progress" }) })).rejects.toThrow(
      /connection reset/,
    );
  });

  it("swallows and reports a completion failure, since the handler has committed", async () => {
    const seen: string[] = [];
    const store = new ReportingIdempotencyStore(
      innerStore({
        complete: async () => {
          throw new Error("disk full");
        },
      }),
      { onPersistError: (_err, at) => seen.push(at.key) },
    );
    await store.complete({ tenantId: TENANT, record: record(), replay: null });
    expect(store.report()).toMatchObject({ failed: 1, firstFailure: "disk full" });
    expect(seen).toEqual(["key-delete-1"]);
  });

  it("swallows a release failure and counts it apart from records that were not stored", async () => {
    // A lost release answers the next retry 409 until the lease lapses; it never makes a mutation
    // re-execute, so counting it in `failed` made the shutdown line claim exactly that.
    const seen: string[] = [];
    const store = new ReportingIdempotencyStore(
      innerStore({
        release: async () => {
          throw new Error("gone");
        },
      }),
      { onPersistError: (_err, at) => seen.push(at.operation) },
    );
    await store.release({ tenantId: TENANT, key: "key-delete-1", requestHashSha256: "a".repeat(64) });
    expect(store.report()).toMatchObject({ persisted: 0, failed: 0, releaseFailed: 1 });
    expect(seen).toEqual(["release"]);
  });

  it("does not count a successful release as a stored record", async () => {
    const store = new ReportingIdempotencyStore(innerStore({}));
    await store.release({ tenantId: TENANT, key: "key-delete-1", requestHashSha256: "a".repeat(64) });
    await store.complete({ tenantId: TENANT, record: record(), replay: null });
    expect(store.report()).toMatchObject({ persisted: 1, failed: 0, releaseFailed: 0 });
  });
});

describe("IDEMPOTENCY_GUARANTEE", () => {
  // It used to say two concurrent retries could both execute, which was true before the gateway
  // reserved the key. The sentence names what is now bounded and what is still not.
  it("states the concurrent answer and the lease bound", () => {
    expect(IDEMPOTENCY_GUARANTEE).toContain("409 in progress");
    expect(IDEMPOTENCY_GUARANTEE).toContain("lease");
    expect(IDEMPOTENCY_GUARANTEE).not.toContain("can still both execute");
  });
});

describe("pruneIdempotencyRecords", () => {
  it("sweeps every active tenant with its own scope", async () => {
    const seen: string[] = [];
    const result = await pruneIdempotencyRecords({
      store: {
        deleteExpired: async (_now: Date, tenantId: string) => {
          seen.push(tenantId);
          return 2;
        },
      },
      tenants: { activeTenantIds: () => ["t1", "t2", "t3"] },
    });
    expect(seen).toEqual(["t1", "t2", "t3"]);
    expect(result).toMatchObject({ tenantsSwept: 3, deleted: 6, failures: [] });
  });

  it("passes one cutoff instant to every tenant in a pass", async () => {
    const instants: number[] = [];
    await pruneIdempotencyRecords({
      store: {
        deleteExpired: async (now: Date) => {
          instants.push(now.getTime());
          return 0;
        },
      },
      tenants: { activeTenantIds: () => ["t1", "t2"] },
      now: () => new Date("2026-05-16T12:00:00.000Z"),
    });
    expect(new Set(instants).size).toBe(1);
  });

  it("continues past one tenant's failure and names it", async () => {
    const result = await pruneIdempotencyRecords({
      store: {
        deleteExpired: async (_now: Date, tenantId: string) => {
          if (tenantId === "t2") throw new Error("permission denied");
          return 1;
        },
      },
      tenants: { activeTenantIds: () => ["t1", "t2", "t3"] },
    });
    expect(result.deleted).toBe(2);
    expect(result.failures).toEqual([{ tenantId: "t2", message: "permission denied" }]);
  });

  it("does nothing when no tenant is active", async () => {
    const deleteExpired = vi.fn(async () => 0);
    const result = await pruneIdempotencyRecords({
      store: { deleteExpired },
      tenants: { activeTenantIds: () => [] },
    });
    expect(deleteExpired).not.toHaveBeenCalled();
    expect(result).toMatchObject({ tenantsSwept: 0, deleted: 0 });
  });

  it("awaits an async tenant source", async () => {
    const result = await pruneIdempotencyRecords({
      store: { deleteExpired: async () => 5 },
      tenants: { activeTenantIds: async () => ["t1"] },
    });
    expect(result.deleted).toBe(5);
  });
});

describe("IdempotencyPruneScheduler", () => {
  interface FakeScheduler {
    readonly scheduler: IntervalScheduler;
    readonly intervals: readonly number[];
    cleared(): number;
  }

  function fakeScheduler(): FakeScheduler {
    const intervals: number[] = [];
    let cleared = 0;
    return {
      scheduler: {
        setInterval(_handler: () => void, ms: number): IntervalHandle {
          intervals.push(ms);
          return intervals.length as unknown as IntervalHandle;
        },
        clearInterval(): void {
          cleared += 1;
        },
      },
      intervals,
      cleared: () => cleared,
    };
  }

  it("sweeps at boot and reports", async () => {
    const swept: number[] = [];
    const fake = fakeScheduler();
    const sched = new IdempotencyPruneScheduler({
      store: { deleteExpired: async () => 4 },
      tenants: { activeTenantIds: () => ["t1"] },
      scheduler: fake.scheduler,
      onSwept: (r) => swept.push(r.deleted),
    });
    sched.start();
    await sched.sweepOnce();
    expect(swept).toContain(4);
  });

  it("defaults to the hourly interval", () => {
    const fake = fakeScheduler();
    new IdempotencyPruneScheduler({
      store: { deleteExpired: async () => 0 },
      tenants: { activeTenantIds: () => [] },
      scheduler: fake.scheduler,
    }).start();
    expect(fake.intervals).toEqual([DEFAULT_IDEMPOTENCY_PRUNE_MS]);
  });

  it("honours an explicit interval", () => {
    const fake = fakeScheduler();
    new IdempotencyPruneScheduler({
      store: { deleteExpired: async () => 0 },
      tenants: { activeTenantIds: () => [] },
      intervalMs: 60_000,
      scheduler: fake.scheduler,
    }).start();
    expect(fake.intervals).toEqual([60_000]);
  });

  it("start is idempotent", () => {
    const fake = fakeScheduler();
    const sched = new IdempotencyPruneScheduler({
      store: { deleteExpired: async () => 0 },
      tenants: { activeTenantIds: () => [] },
      scheduler: fake.scheduler,
    });
    sched.start();
    sched.start();
    expect(fake.intervals).toHaveLength(1);
  });

  it("stop clears the timer and is safe twice", () => {
    const fake = fakeScheduler();
    const sched = new IdempotencyPruneScheduler({
      store: { deleteExpired: async () => 0 },
      tenants: { activeTenantIds: () => [] },
      scheduler: fake.scheduler,
    });
    sched.start();
    sched.stop();
    sched.stop();
    expect(fake.cleared()).toBe(1);
  });

  /** A timer callback must never reject: a thrown sweep would be an unhandled rejection. */
  it("routes a tenant-source failure to onError rather than throwing", async () => {
    const onError = vi.fn();
    const fake = fakeScheduler();
    const sched = new IdempotencyPruneScheduler({
      store: { deleteExpired: async () => 0 },
      tenants: {
        activeTenantIds: () => {
          throw new Error("tenants unreadable");
        },
      },
      scheduler: fake.scheduler,
      onError,
    });
    await expect(sched.sweepOnce()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
