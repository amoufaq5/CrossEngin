import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";
import { PipelineExecutionSchema, type PipelineExecution } from "@crossengin/api-gateway";
import { CountingUuidGenerator } from "@crossengin/billing-runtime";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

import type { RefusedUsageRecord } from "@crossengin/billing-runtime-pg";

import {
  MeteringFlushScheduler,
  UsageRecordsRefused,
  buildRequestMetering,
  takeUsageWindow,
  meteredEventFromExecution,
  parseMeteringConfig,
  policyFromConfig,
} from "./metering.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const SUB = "22222222-2222-2222-2222-222222222222";

const config = parseMeteringConfig({ tenantSubscriptions: { [TENANT]: SUB } });
const policy = policyFromConfig(config);

/**
 * `failInserts` answers per INSERT: `true` raises a transport error (no SQLSTATE), an `Error` is
 * raised as given — so a test can raise what a real database raises for a refused record.
 */
function fakePg(failInserts: (params: readonly unknown[]) => boolean | Error = () => false): {
  conn: PgConnection;
  calls: string[];
} {
  const calls: string[] = [];
  const conn: PgConnection = {
    query: (async (sql: string, params: readonly unknown[] = []) => {
      calls.push(sql);
      if (sql.includes("INSERT INTO")) {
        const fail = failInserts(params);
        if (fail instanceof Error) throw fail;
        if (fail) throw new Error("connection reset");
        return { rows: [], rowCount: 1 } as PgQueryResult;
      }
      return { rows: [], rowCount: 0 } as PgQueryResult;
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T,>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => {}) as PgConnection["close"],
  };
  return { conn, calls };
}

function execution(overrides: {
  readonly tenantId?: string | null;
  readonly status?: number;
  readonly requestId?: string;
}): PipelineExecution {
  const status = overrides.status ?? 200;
  const stage = status >= 400 ? "dispatch_handler" : "emit_audit";
  const outcome = status >= 500 ? "error" : status >= 400 ? "deny" : "pass";
  return PipelineExecutionSchema.parse({
    requestId: overrides.requestId ?? "req_abcdefgh12345",
    tenantId: overrides.tenantId === undefined ? TENANT : overrides.tenantId,
    startedAt: "2026-06-15T12:00:00.000Z",
    completedAt: "2026-06-15T12:00:00.040Z",
    totalDurationMs: 40,
    finalStage: stage,
    finalOutcome: outcome,
    finalResponseStatus: status,
    stages: [
      {
        stage,
        outcome,
        startedAt: "2026-06-15T12:00:00.000Z",
        completedAt: "2026-06-15T12:00:00.040Z",
        durationMs: 40,
        reason: "test",
        appliedHeaders: {},
        problemTypeUri: status >= 400 ? "https://crossengin.io/problems/test" : null,
        responseStatus: status,
      },
    ],
    authOutcome: "authenticated",
    routeMatchOutcome: "matched",
    idempotencyOutcome: "no_key_required",
    principalId: null,
    routeOperationId: "product.list",
    resolvedApiVersion: "v1",
    correlationId: null,
    rateLimitDecisionId: null,
    bytesIn: 0,
    bytesOut: 0,
  });
}

describe("parseMeteringConfig", () => {
  it("applies meter/source/quantity defaults", () => {
    expect(config.meter).toBe("integration_call");
    expect(config.source).toBe("integration_calls");
    expect(config.quantityPerRequest).toBe(1);
  });

  it("rejects unknown keys + a non-uuid subscription", () => {
    expect(() => parseMeteringConfig({ tenantSubscriptions: {}, bogus: 1 })).toThrow();
    expect(() => parseMeteringConfig({ tenantSubscriptions: { [TENANT]: "not-uuid" } })).toThrow();
  });
});

describe("meteredEventFromExecution", () => {
  it("meters a 2xx request for a mapped tenant, keyed by request id", () => {
    const event = meteredEventFromExecution(execution({ requestId: "req_req000001" }), policy);
    expect(event?.subscriptionId).toBe(SUB);
    expect(event?.meter).toBe("integration_call");
    expect(event?.idempotencyKey).toBe("req_req000001");
  });

  it("skips an unauthenticated request (no tenant)", () => {
    expect(meteredEventFromExecution(execution({ tenantId: null }), policy)).toBeNull();
  });

  it("skips a 4xx/5xx response by default", () => {
    expect(meteredEventFromExecution(execution({ status: 404 }), policy)).toBeNull();
    expect(meteredEventFromExecution(execution({ status: 503 }), policy)).toBeNull();
  });

  it("skips a tenant with no mapped subscription", () => {
    expect(
      meteredEventFromExecution(execution({ tenantId: "99999999-9999-9999-9999-999999999999" }), policy),
    ).toBeNull();
  });

  it("honours an explicit countStatuses list", () => {
    const p = policyFromConfig(parseMeteringConfig({ tenantSubscriptions: { [TENANT]: SUB }, countStatuses: [201] }));
    expect(meteredEventFromExecution(execution({ status: 200 }), p)).toBeNull();
    expect(meteredEventFromExecution(execution({ status: 201 }), p)).not.toBeNull();
  });
});

describe("RequestMeteringObserver + takeUsageWindow", () => {
  it("accumulates billable requests and takes them out of the meter as one window", () => {
    const { conn } = fakePg();
    const { engine, observer } = buildRequestMetering(conn, config);
    for (let i = 0; i < 5; i += 1) {
      observer.observe(execution({ requestId: `req_r${i.toString().padStart(8, "0")}` }));
    }
    observer.observe(execution({ tenantId: null })); // not billable
    expect(observer.meteredSubscriptions()).toEqual([SUB]);
    expect(engine.engine.usage(SUB)[0]?.quantity).toBe(5);

    const records = takeUsageWindow(engine, observer.meteredSubscriptions(), {
      period: { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
      source: "integration_calls",
      recordedAt: "2026-07-01T00:00:00.000Z",
      ids: new CountingUuidGenerator(),
      writer: "replica-a",
    });
    expect(records.map((r) => r.quantity)).toEqual([5]);
    expect(engine.engine.usage(SUB)).toEqual([]);
  });

  it("de-duplicates a repeated request id (no double-count)", () => {
    const { conn } = fakePg();
    const { engine, observer } = buildRequestMetering(conn, config);
    observer.observe(execution({ requestId: "req_dup00001" }));
    observer.observe(execution({ requestId: "req_dup00001" }));
    expect(engine.engine.usage(SUB)[0]?.quantity).toBe(1);
  });
});

function scheduler(
  built: ReturnType<typeof buildRequestMetering>,
  clock: () => Date,
  sinks: { flushes?: number[]; errors?: unknown[]; refused?: RefusedUsageRecord[] } = {},
  writer = "test-writer",
): MeteringFlushScheduler {
  return new MeteringFlushScheduler({
    observer: built.observer,
    engine: built.engine,
    source: "integration_calls",
    intervalMs: 1_000,
    ids: new CountingUuidGenerator(),
    clock,
    onFlush: (n) => sinks.flushes?.push(n),
    onError: (err) => sinks.errors?.push(err),
    onRefused: (r) => sinks.refused?.push(...r),
    writer,
  });
}

describe("MeteringFlushScheduler", () => {
  it("flushes the window since the previous tick", async () => {
    const { conn } = fakePg();
    const built = buildRequestMetering(conn, config);
    built.observer.observe(execution({ requestId: "req_flush0001" }));
    let t = new Date("2026-06-15T12:00:00.000Z");
    const flushes: number[] = [];
    const s = scheduler(built, () => t, { flushes });
    t = new Date("2026-06-15T12:05:00.000Z");
    expect(await s.flushOnce()).toBe(1);
    expect(flushes).toEqual([1]);
  });

  it("no-ops when no time has elapsed", async () => {
    const { conn } = fakePg();
    const built = buildRequestMetering(conn, config);
    expect(await scheduler(built, () => new Date("2026-06-15T12:00:00.000Z")).flushOnce()).toBe(0);
  });

  // The defect: every window opening on one day shared a key, so the second flush's upsert replaced
  // the first's quantity and that usage was never billed.
  it("writes two flushes on one day as two records under two keys", async () => {
    const { conn } = fakePg();
    const built = buildRequestMetering(conn, config);
    const keys: string[] = [];
    const quantities: number[] = [];
    const original = built.engine.usageStore.recordWindow.bind(built.engine.usageStore);
    built.engine.usageStore.recordWindow = async (records) => {
      for (const r of records) {
        keys.push(r.idempotencyKey);
        quantities.push(r.quantity);
      }
      return original(records);
    };
    let t = new Date("2026-06-15T12:00:00.000Z");
    const s = scheduler(built, () => t);
    built.observer.observe(execution({ requestId: "req_day00001" }));
    built.observer.observe(execution({ requestId: "req_day00002" }));
    t = new Date("2026-06-15T12:01:00.000Z");
    await s.flushOnce();
    built.observer.observe(execution({ requestId: "req_day00003" }));
    t = new Date("2026-06-15T12:02:00.000Z");
    await s.flushOnce();
    expect(quantities).toEqual([2, 1]);
    expect(new Set(keys).size).toBe(2);
  });

  // The defect: a failed flush had cleared the subscriptions it wrote and not advanced the window,
  // so the retry overwrote their rows with only the newer usage. A failed window now stays pending
  // and is retried unchanged — same records, same keys — beside the next one.
  it("keeps a failed window pending and retries it unchanged beside the next one", async () => {
    let failing = true;
    const { conn } = fakePg(() => failing);
    const built = buildRequestMetering(conn, config);
    const written: string[] = [];
    const original = built.engine.usageStore.recordWindow.bind(built.engine.usageStore);
    built.engine.usageStore.recordWindow = async (records) => {
      const n = await original(records);
      for (const r of records) written.push(`${r.id}:${r.quantity.toString()}`);
      return n;
    };
    let t = new Date("2026-06-15T12:00:00.000Z");
    const errors: unknown[] = [];
    const s = scheduler(built, () => t, { errors });
    built.observer.observe(execution({ requestId: "req_fail0001" }));
    t = new Date("2026-06-15T12:01:00.000Z");
    expect(await s.flushOnce()).toBe(0);
    expect(errors).toHaveLength(1);
    expect(s.pendingRecords()).toBe(1);
    built.observer.observe(execution({ requestId: "req_fail0002" }));
    failing = false;
    t = new Date("2026-06-15T12:02:00.000Z");
    expect(await s.flushOnce()).toBe(2);
    expect(s.pendingRecords()).toBe(0);
    // The first window kept its id; the second is its own record.
    expect(written).toEqual([
      "00000000-0000-4000-8000-000000000001:1",
      "00000000-0000-4000-8000-000000000002:1",
    ]);
  });

  // A store that stays down must not grow the process by a window per tick: no window is cut while
  // one is pending, so the usage stays in the meter's bounded buckets and the next cut spans the gap.
  it("cuts no new window while one is pending, so an outage holds one window and not one per tick", async () => {
    let failing = true;
    const { conn } = fakePg(() => failing);
    const built = buildRequestMetering(conn, config);
    const periods: string[] = [];
    const original = built.engine.usageStore.recordWindow.bind(built.engine.usageStore);
    built.engine.usageStore.recordWindow = async (records) => {
      const n = await original(records);
      for (const r of records) periods.push(`${r.period.start}>${r.period.end}:${r.quantity.toString()}`);
      return n;
    };
    let t = new Date("2026-06-15T12:00:00.000Z");
    const s = scheduler(built, () => t);
    built.observer.observe(execution({ requestId: "req_out00001" }));
    t = new Date("2026-06-15T12:01:00.000Z");
    await s.flushOnce();
    for (const [i, minute] of [[2, "02"], [3, "03"], [4, "04"]] as const) {
      built.observer.observe(execution({ requestId: `req_out0000${i.toString()}` }));
      t = new Date(`2026-06-15T12:${minute}:00.000Z`);
      await s.flushOnce();
    }
    expect(s.pendingRecords()).toBe(1);
    expect(built.engine.engine.usage(SUB)[0]?.quantity).toBe(3);
    failing = false;
    t = new Date("2026-06-15T12:05:00.000Z");
    expect(await s.flushOnce()).toBe(2);
    expect(periods).toEqual([
      "2026-06-15T12:00:00.000Z>2026-06-15T12:01:00.000Z:1",
      "2026-06-15T12:01:00.000Z>2026-06-15T12:05:00.000Z:3",
    ]);
  });

  it("serialises overlapping flushes so two cannot cut one span twice", async () => {
    const { conn } = fakePg();
    const built = buildRequestMetering(conn, config);
    let t = new Date("2026-06-15T12:00:00.000Z");
    const s = scheduler(built, () => t);
    built.observer.observe(execution({ requestId: "req_ser00001" }));
    t = new Date("2026-06-15T12:01:00.000Z");
    const [a, b] = await Promise.all([s.flushOnce(), s.flushOnce()]);
    expect(a + b).toBe(1);
  });

  // ADR-0483: two replicas cut windows over overlapping instants, and a key built from the window
  // start alone made the second replica's insert a silent ON CONFLICT DO NOTHING.
  it("gives two writers' windows over one span two keys", async () => {
    const keys: string[] = [];
    for (const writer of ["replica-a", "replica-b"]) {
      const { conn } = fakePg();
      const built = buildRequestMetering(conn, config);
      const original = built.engine.usageStore.recordWindow.bind(built.engine.usageStore);
      built.engine.usageStore.recordWindow = async (records) => {
        for (const r of records) keys.push(r.idempotencyKey);
        return original(records);
      };
      let t = new Date("2026-06-15T12:00:00.000Z");
      const s = scheduler(built, () => t, {}, writer);
      built.observer.observe(execution({ requestId: `req_${writer}` }));
      t = new Date("2026-06-15T12:01:00.000Z");
      await s.flushOnce();
    }
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toContain(":writer=replica-a");
  });

  it("defaults the writer to one stable id per scheduler, distinct between instances", () => {
    const { conn } = fakePg();
    const a = buildRequestMetering(conn, config).flushScheduler;
    const b = buildRequestMetering(conn, config).flushScheduler;
    expect(a.writerId()).toBe(a.writerId());
    expect(a.writerId()).not.toBe(b.writerId());
  });

  // ADR-0483: one record the database refuses (here an unprovisioned tenant's foreign key) used to
  // roll back the whole window and, being permanent, keep it pending for ever.
  it("drops a refused record from pending, reports it, and writes the rest", async () => {
    const OTHER = "44444444-4444-4444-4444-444444444444";
    const OTHER_SUB = "55555555-5555-5555-5555-555555555555";
    const twoTenants = parseMeteringConfig({ tenantSubscriptions: { [TENANT]: SUB, [OTHER]: OTHER_SUB } });
    const fk = Object.assign(new Error(`insert violates fk (tenant ${OTHER})`), {
      code: "23503",
      constraint: "billing_usage_records_tenant_id_fkey",
    });
    const { conn } = fakePg((params) => (params[1] === OTHER ? fk : false));
    const built = buildRequestMetering(conn, twoTenants);
    let t = new Date("2026-06-15T12:00:00.000Z");
    const refused: RefusedUsageRecord[] = [];
    const errors: unknown[] = [];
    const s = scheduler(built, () => t, { refused, errors });
    built.observer.observe(execution({ requestId: "req_ref00001" }));
    built.observer.observe(execution({ requestId: "req_ref00002", tenantId: OTHER }));
    t = new Date("2026-06-15T12:01:00.000Z");
    expect(await s.flushOnce()).toBe(1);
    expect(s.pendingRecords()).toBe(0);
    expect(errors).toEqual([]);
    expect(refused.map((r) => [r.record.tenantId, r.sqlstate])).toEqual([[OTHER, "23503"]]);
  });

  it("logs refusals as their own line when no onRefused is given — never as a flush error, naming no tenant", async () => {
    const OTHER = "44444444-4444-4444-4444-444444444444";
    const twoTenants = parseMeteringConfig({
      tenantSubscriptions: { [TENANT]: SUB, [OTHER]: "55555555-5555-5555-5555-555555555555" },
    });
    const fk = Object.assign(new Error("fk"), { code: "23503", constraint: "billing_usage_records_tenant_id_fkey" });
    const { conn } = fakePg((params) => (params[1] === OTHER ? fk : false));
    const errors: unknown[] = [];
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    try {
      const built = buildRequestMetering(conn, twoTenants, { onError: (e) => errors.push(e) });
      built.observer.observe(execution({ requestId: "req_ref00003", tenantId: OTHER }));
      await built.flushScheduler.flushOnce();
      // The scheduler's own clock is real, so give the window a span before flushing again.
      await new Promise((r) => setTimeout(r, 5));
      await built.flushScheduler.flushOnce();
    } finally {
      spy.mockRestore();
    }
    // `onError` means "a window did not write"; this one did, minus a dropped record (ADR-0483).
    expect(errors).toEqual([]);
    expect(logged).toHaveLength(1);
    const line = String(logged[0]?.[0]);
    expect(line).toMatch(/^\[metering\] 1 usage record\(s\) refused by the database and dropped/);
    expect(line).toContain("SQLSTATE 23503 on billing_usage_records_tenant_id_fkey");
    expect(line).not.toContain(OTHER);
  });

  it("keeps the refused rows off an inspected UsageRecordsRefused, which carries tenant ids", () => {
    const OTHER = "44444444-4444-4444-4444-444444444444";
    const refused = [
      {
        record: { tenantId: OTHER, meter: "ai_call", quantity: 7 } as unknown as RefusedUsageRecord["record"],
        sqlstate: "23503",
        constraint: "c",
        detail: "SQLSTATE 23503 on c",
      },
    ];
    const err = new UsageRecordsRefused(refused);
    expect(err.refused).toBe(refused);
    expect(inspect(err, { depth: 10 })).not.toContain(OTHER);
  });

  it("always builds a scheduler, defaulting the interval, since nothing else ever flushed", () => {
    const { conn } = fakePg();
    const built = buildRequestMetering(conn, config);
    expect(built.flushScheduler).toBeInstanceOf(MeteringFlushScheduler);
    expect(config.flushIntervalMs).toBe(60_000);
  });
});
