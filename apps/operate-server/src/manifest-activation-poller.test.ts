import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  ManifestActivationPoller,
  PostgresActivationWatermarkSource,
  type ActivationWatermarkSource,
} from "./manifest-activation-poller.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface ScriptedSource extends ActivationWatermarkSource {
  set(map: Record<string, string>): void;
  fail(err: unknown): void;
  calls(): number;
}

function scriptedSource(initial: Record<string, string> = {}): ScriptedSource {
  let current: Record<string, string> = initial;
  let error: unknown = null;
  let calls = 0;
  return {
    activationWatermarks(): Promise<ReadonlyMap<string, string>> {
      calls += 1;
      if (error !== null) {
        const err = error;
        error = null;
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      return Promise.resolve(new Map(Object.entries(current)));
    },
    set(map: Record<string, string>): void {
      current = map;
    },
    fail(err: unknown): void {
      error = err;
    },
    calls(): number {
      return calls;
    },
  };
}

function fakeCache(): { invalidate(tenantId: string): void; calls: string[] } {
  const calls: string[] = [];
  return {
    invalidate(tenantId: string): void {
      calls.push(tenantId);
    },
    calls,
  };
}

interface FakeTimer {
  setTimer: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimer: (handle: unknown) => void;
  fire(): void;
  registrations: number;
  cleared: number;
  unrefs: number;
  lastMs: number | null;
}

function fakeTimer(): FakeTimer {
  const state: FakeTimer = {
    setTimer: (fn: () => void, ms: number) => {
      state.registrations += 1;
      state.lastMs = ms;
      handler = fn;
      return {
        unref: (): void => {
          state.unrefs += 1;
        },
      };
    },
    clearTimer: (): void => {
      state.cleared += 1;
      handler = null;
    },
    fire: (): void => {
      handler?.();
    },
    registrations: 0,
    cleared: 0,
    unrefs: 0,
    lastMs: null,
  };
  let handler: (() => void) | null = null;
  return state;
}

describe("ManifestActivationPoller", () => {
  it("records a baseline on the first poll without invalidating", async () => {
    const source = scriptedSource({ [TENANT_A]: "2026-08-01T00:00:00.000Z" });
    const cache = fakeCache();
    const poller = new ManifestActivationPoller({ source, cache, intervalMs: 5_000 });

    await poller.poll();

    expect(cache.calls).toEqual([]);
  });

  it("invalidates exactly the tenant whose watermark changed", async () => {
    const source = scriptedSource({
      [TENANT_A]: "2026-08-01T00:00:00.000Z",
      [TENANT_B]: "2026-08-01T00:00:00.000Z",
    });
    const cache = fakeCache();
    const poller = new ManifestActivationPoller({ source, cache, intervalMs: 5_000 });

    await poller.poll();
    source.set({ [TENANT_A]: "2026-08-02T00:00:00.000Z", [TENANT_B]: "2026-08-01T00:00:00.000Z" });
    await poller.poll();

    expect(cache.calls).toEqual([TENANT_A]);
  });

  it("invalidates a changed watermark only once", async () => {
    const source = scriptedSource({ [TENANT_A]: "2026-08-01T00:00:00.000Z" });
    const cache = fakeCache();
    const poller = new ManifestActivationPoller({ source, cache, intervalMs: 5_000 });

    await poller.poll();
    source.set({ [TENANT_A]: "2026-08-02T00:00:00.000Z" });
    await poller.poll();
    await poller.poll();
    await poller.poll();

    expect(cache.calls).toEqual([TENANT_A]);
  });

  it("does not invalidate an unchanged watermark", async () => {
    const source = scriptedSource({ [TENANT_A]: "2026-08-01T00:00:00.000Z" });
    const cache = fakeCache();
    const poller = new ManifestActivationPoller({ source, cache, intervalMs: 5_000 });

    await poller.poll();
    await poller.poll();
    await poller.poll();

    expect(cache.calls).toEqual([]);
  });

  it("invalidates a tenant that newly appears after the baseline", async () => {
    const source = scriptedSource({ [TENANT_A]: "2026-08-01T00:00:00.000Z" });
    const cache = fakeCache();
    const poller = new ManifestActivationPoller({ source, cache, intervalMs: 5_000 });

    await poller.poll();
    source.set({ [TENANT_A]: "2026-08-01T00:00:00.000Z", [TENANT_B]: "2026-08-03T00:00:00.000Z" });
    await poller.poll();

    expect(cache.calls).toEqual([TENANT_B]);
  });

  it("invalidates a tenant whose active manifest disappears, exactly once", async () => {
    const source = scriptedSource({
      [TENANT_A]: "2026-08-01T00:00:00.000Z",
      [TENANT_B]: "2026-08-01T00:00:00.000Z",
    });
    const cache = fakeCache();
    const poller = new ManifestActivationPoller({ source, cache, intervalMs: 5_000 });

    await poller.poll();
    source.set({ [TENANT_A]: "2026-08-01T00:00:00.000Z" });
    await poller.poll();
    await poller.poll();
    await poller.poll();

    expect(cache.calls).toEqual([TENANT_B]);
  });

  it("re-invalidates a tenant that reappears after disappearing", async () => {
    const source = scriptedSource({ [TENANT_A]: "2026-08-01T00:00:00.000Z" });
    const cache = fakeCache();
    const poller = new ManifestActivationPoller({ source, cache, intervalMs: 5_000 });

    await poller.poll();
    source.set({});
    await poller.poll();
    source.set({ [TENANT_A]: "2026-08-01T00:00:00.000Z" });
    await poller.poll();

    expect(cache.calls).toEqual([TENANT_A, TENANT_A]);
  });

  it("reports the watermark that triggered each invalidation", async () => {
    const source = scriptedSource({ [TENANT_A]: "2026-08-01T00:00:00.000Z" });
    const cache = fakeCache();
    const seen: [string, string][] = [];
    const poller = new ManifestActivationPoller({
      source,
      cache,
      intervalMs: 5_000,
      onInvalidated: (tenantId, watermark) => seen.push([tenantId, watermark]),
    });

    await poller.poll();
    source.set({ [TENANT_A]: "2026-08-04T12:00:00.000Z" });
    await poller.poll();

    expect(seen).toEqual([[TENANT_A, "2026-08-04T12:00:00.000Z"]]);
  });

  it("routes a source failure to onError without invalidating or throwing", async () => {
    const source = scriptedSource({ [TENANT_A]: "2026-08-01T00:00:00.000Z" });
    const cache = fakeCache();
    const errors: unknown[] = [];
    const poller = new ManifestActivationPoller({
      source,
      cache,
      intervalMs: 5_000,
      onError: (err) => errors.push(err),
    });

    await poller.poll();
    source.fail(new Error("connection reset"));
    await expect(poller.poll()).resolves.toBeUndefined();

    expect(cache.calls).toEqual([]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("connection reset");
  });

  it("leaves the baseline untouched on failure so the next poll still detects the change", async () => {
    const source = scriptedSource({ [TENANT_A]: "2026-08-01T00:00:00.000Z" });
    const cache = fakeCache();
    const poller = new ManifestActivationPoller({ source, cache, intervalMs: 5_000 });

    await poller.poll();
    source.set({ [TENANT_A]: "2026-08-05T00:00:00.000Z" });
    source.fail(new Error("timeout"));
    await expect(poller.poll()).resolves.toBeUndefined();
    expect(cache.calls).toEqual([]);

    await poller.poll();
    expect(cache.calls).toEqual([TENANT_A]);
  });

  it("routes a cache failure to onError instead of throwing", async () => {
    const source = scriptedSource({ [TENANT_A]: "2026-08-01T00:00:00.000Z" });
    const errors: unknown[] = [];
    const poller = new ManifestActivationPoller({
      source,
      cache: {
        invalidate: (): void => {
          throw new Error("cache exploded");
        },
      },
      intervalMs: 5_000,
      onError: (err) => errors.push(err),
    });

    await poller.poll();
    source.set({ [TENANT_A]: "2026-08-06T00:00:00.000Z" });
    await expect(poller.poll()).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
  });

  it("polls immediately on start and registers an unref'd interval", async () => {
    const source = scriptedSource({ [TENANT_A]: "2026-08-01T00:00:00.000Z" });
    const cache = fakeCache();
    const timer = fakeTimer();
    const poller = new ManifestActivationPoller({
      source,
      cache,
      intervalMs: 7_000,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    poller.start();
    await flush();

    expect(source.calls()).toBe(1);
    expect(timer.registrations).toBe(1);
    expect(timer.lastMs).toBe(7_000);
    expect(timer.unrefs).toBe(1);
    poller.stop();
  });

  it("polls again when the timer fires", async () => {
    const source = scriptedSource({ [TENANT_A]: "2026-08-01T00:00:00.000Z" });
    const cache = fakeCache();
    const timer = fakeTimer();
    const poller = new ManifestActivationPoller({
      source,
      cache,
      intervalMs: 5_000,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    poller.start();
    await flush();
    source.set({ [TENANT_A]: "2026-08-07T00:00:00.000Z" });
    timer.fire();
    await flush();

    expect(source.calls()).toBe(2);
    expect(cache.calls).toEqual([TENANT_A]);
    poller.stop();
  });

  it("start() is idempotent", async () => {
    const source = scriptedSource({});
    const timer = fakeTimer();
    const poller = new ManifestActivationPoller({
      source,
      cache: fakeCache(),
      intervalMs: 5_000,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    poller.start();
    poller.start();
    poller.start();
    await flush();

    expect(timer.registrations).toBe(1);
    expect(source.calls()).toBe(1);
    poller.stop();
  });

  it("stop() clears the timer, prevents further polls, and is idempotent", async () => {
    const source = scriptedSource({});
    const timer = fakeTimer();
    const poller = new ManifestActivationPoller({
      source,
      cache: fakeCache(),
      intervalMs: 5_000,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    poller.start();
    await flush();
    poller.stop();
    poller.stop();
    timer.fire();
    await flush();

    expect(timer.cleared).toBe(1);
    expect(source.calls()).toBe(1);
  });

  it("rejects an interval below one second", () => {
    const opts = { source: scriptedSource({}), cache: fakeCache() };
    expect(() => new ManifestActivationPoller({ ...opts, intervalMs: 999 })).toThrow(/at least 1000/);
    expect(() => new ManifestActivationPoller({ ...opts, intervalMs: 0 })).toThrow(/at least 1000/);
    expect(() => new ManifestActivationPoller({ ...opts, intervalMs: Number.NaN })).toThrow(/at least 1000/);
    expect(() => new ManifestActivationPoller({ ...opts, intervalMs: 1_000 })).not.toThrow();
  });
});

interface CapturedQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function fakeWatermarkDb(rows: Record<string, unknown>[]): {
  conn: PgConnection;
  captured: CapturedQuery[];
  transactions: number;
} {
  const captured: CapturedQuery[] = [];
  const state = { transactions: 0 };
  const conn: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      return Promise.resolve({ rows, rowCount: rows.length });
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      state.transactions += 1;
      return fn(conn);
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return {
    conn,
    captured,
    get transactions(): number {
      return state.transactions;
    },
  };
}

describe("PostgresActivationWatermarkSource", () => {
  it("issues one aggregate query filtered to active rows with an activation instant", async () => {
    const db = fakeWatermarkDb([]);
    const map = await new PostgresActivationWatermarkSource(db.conn).activationWatermarks();

    expect(map.size).toBe(0);
    expect(db.captured).toHaveLength(1);
    const sql = db.captured[0]?.sql ?? "";
    expect(sql).toContain("MAX(activated_at) AS watermark");
    expect(sql).toContain("FROM meta.operate_tenant_manifests");
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("activated_at IS NOT NULL");
    expect(sql).toContain("GROUP BY tenant_id");
  });

  it("runs as a platform sweep — no set_config, no transaction", async () => {
    const db = fakeWatermarkDb([{ tenant_id: TENANT_A, watermark: "2026-08-01T00:00:00.000Z" }]);
    await new PostgresActivationWatermarkSource(db.conn).activationWatermarks();

    expect(db.captured.some((q) => q.sql.includes("set_config"))).toBe(false);
    expect(db.transactions).toBe(0);
  });

  it("maps Date and string activation instants into ISO watermarks", async () => {
    const db = fakeWatermarkDb([
      { tenant_id: TENANT_A, watermark: new Date(Date.UTC(2026, 7, 1, 12, 30)) },
      { tenant_id: TENANT_B, watermark: "2026-08-02T09:15:00.000Z" },
    ]);

    const map = await new PostgresActivationWatermarkSource(db.conn).activationWatermarks();

    expect(map.get(TENANT_A)).toBe("2026-08-01T12:30:00.000Z");
    expect(map.get(TENANT_B)).toBe("2026-08-02T09:15:00.000Z");
    expect(map.size).toBe(2);
  });

  it("skips rows with a null tenant or unparseable watermark", async () => {
    const db = fakeWatermarkDb([
      { tenant_id: TENANT_A, watermark: "2026-08-01T00:00:00.000Z" },
      { tenant_id: null, watermark: "2026-08-01T00:00:00.000Z" },
      { tenant_id: TENANT_B, watermark: null },
      { tenant_id: TENANT_B, watermark: "not-a-date" },
    ]);

    const map = await new PostgresActivationWatermarkSource(db.conn).activationWatermarks();

    expect([...map.keys()]).toEqual([TENANT_A]);
  });

  it("honors a custom schema and rejects an invalid identifier", async () => {
    const db = fakeWatermarkDb([]);
    await new PostgresActivationWatermarkSource(db.conn, { schema: "ops_meta" }).activationWatermarks();
    expect(db.captured[0]?.sql).toContain("FROM ops_meta.operate_tenant_manifests");

    expect(() => new PostgresActivationWatermarkSource(db.conn, { schema: "meta; DROP TABLE x" })).toThrow(
      /invalid schema identifier/,
    );
  });

  it("feeds the poller end to end", async () => {
    const rows: Record<string, unknown>[] = [{ tenant_id: TENANT_A, watermark: new Date(Date.UTC(2026, 7, 1)) }];
    const db = fakeWatermarkDb(rows);
    const cache = fakeCache();
    const poller = new ManifestActivationPoller({
      source: new PostgresActivationWatermarkSource(db.conn),
      cache,
      intervalMs: 5_000,
    });

    await poller.poll();
    expect(cache.calls).toEqual([]);

    rows[0] = { tenant_id: TENANT_A, watermark: new Date(Date.UTC(2026, 7, 2)) };
    await poller.poll();

    expect(cache.calls).toEqual([TENANT_A]);
  });
});
