import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresLatencyTracker } from "./latency-tracker.js";

interface Capture {
  sql: string;
  params: readonly unknown[] | undefined;
}

function mockConnection(
  handler: (sql: string, params: readonly unknown[] | undefined) => PgQueryResult,
  capture?: Capture[],
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (capture !== undefined) capture.push({ sql, params });
      return handler(sql, params);
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

describe("PostgresLatencyTracker.record", () => {
  it("issues an INSERT into meta.llm_latency_samples", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const tracker = new PostgresLatencyTracker({ conn });
    await tracker.record({
      providerId: "anthropic",
      latencyMs: 123,
      success: true,
    });
    expect(capture.length).toBe(1);
    expect(capture[0]?.sql).toContain("INSERT INTO meta.llm_latency_samples");
    expect(capture[0]?.params).toEqual(["anthropic", 123, true]);
  });

  it("threads success=false through", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const tracker = new PostgresLatencyTracker({ conn });
    await tracker.record({
      providerId: "openai",
      latencyMs: 999,
      success: false,
    });
    expect(capture[0]?.params).toEqual(["openai", 999, false]);
  });
});

describe("PostgresLatencyTracker.stats", () => {
  it("returns zero stats when no samples exist", async () => {
    const conn = mockConnection(() => ({
      rows: [{ samples: 0, successes: 0, failures: 0, p50_ms: null, p95_ms: null }],
      rowCount: 1,
    }));
    const tracker = new PostgresLatencyTracker({ conn });
    const stats = await tracker.stats("anthropic");
    expect(stats).toEqual({
      samples: 0,
      successes: 0,
      failures: 0,
      p50Ms: 0,
      p95Ms: 0,
    });
  });

  it("returns parsed stats when samples exist", async () => {
    const conn = mockConnection(() => ({
      rows: [{ samples: 10, successes: 8, failures: 2, p50_ms: 150, p95_ms: 450 }],
      rowCount: 1,
    }));
    const tracker = new PostgresLatencyTracker({ conn });
    const stats = await tracker.stats("anthropic");
    expect(stats).toEqual({
      samples: 10,
      successes: 8,
      failures: 2,
      p50Ms: 150,
      p95Ms: 450,
    });
  });

  it("issues a windowed SELECT with the provider_id + windowSize bound", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [{ samples: 0, successes: 0, failures: 0, p50_ms: null, p95_ms: null }],
        rowCount: 1,
      }),
      capture,
    );
    const tracker = new PostgresLatencyTracker({ conn, windowSize: 50 });
    await tracker.stats("openai");
    expect(capture[0]?.sql).toContain("ORDER BY recorded_at DESC");
    expect(capture[0]?.sql).toContain("LIMIT $2");
    expect(capture[0]?.params).toEqual(["openai", 50]);
  });

  it("uses the default windowSize (100) when omitted", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [{ samples: 0, successes: 0, failures: 0, p50_ms: null, p95_ms: null }],
        rowCount: 1,
      }),
      capture,
    );
    const tracker = new PostgresLatencyTracker({ conn });
    await tracker.stats("bedrock");
    expect(capture[0]?.params?.[1]).toBe(100);
  });

  it("uses percentile_cont for p50/p95 (real percentiles, not nearest-sample)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [{ samples: 5, successes: 5, failures: 0, p50_ms: 30, p95_ms: 48 }],
        rowCount: 1,
      }),
      capture,
    );
    const tracker = new PostgresLatencyTracker({ conn });
    await tracker.stats("x");
    expect(capture[0]?.sql).toContain("percentile_cont(0.5)");
    expect(capture[0]?.sql).toContain("percentile_cont(0.95)");
  });

  it("treats NULL percentile rows as 0 (empty window edge case)", async () => {
    const conn = mockConnection(() => ({
      rows: [{ samples: 5, successes: 5, failures: 0, p50_ms: null, p95_ms: null }],
      rowCount: 1,
    }));
    const tracker = new PostgresLatencyTracker({ conn });
    const stats = await tracker.stats("x");
    expect(stats.samples).toBe(5);
    expect(stats.p50Ms).toBe(0);
    expect(stats.p95Ms).toBe(0);
  });

  it("filters by provider_id (sql includes WHERE provider_id = $1)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [{ samples: 0, successes: 0, failures: 0, p50_ms: null, p95_ms: null }],
        rowCount: 1,
      }),
      capture,
    );
    const tracker = new PostgresLatencyTracker({ conn });
    await tracker.stats("anthropic");
    expect(capture[0]?.sql).toContain("WHERE provider_id = $1");
  });

  it("counts successes / failures via FILTER aggregates", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(
      () => ({
        rows: [{ samples: 3, successes: 2, failures: 1, p50_ms: 100, p95_ms: 100 }],
        rowCount: 1,
      }),
      capture,
    );
    const tracker = new PostgresLatencyTracker({ conn });
    await tracker.stats("x");
    expect(capture[0]?.sql).toContain("FILTER (WHERE success = true)");
    expect(capture[0]?.sql).toContain("FILTER (WHERE success = false)");
  });

  it("isolates providers (separate stats per provider via the WHERE clause)", async () => {
    const calls: { provider: string; params: readonly unknown[] | undefined }[] = [];
    let nextSamples = 5;
    const conn: PgConnection = {
      query: vi.fn(async (_sql: string, params?: readonly unknown[]) => {
        calls.push({ provider: params?.[0] as string, params });
        const samples = nextSamples;
        nextSamples += 5;
        return {
          rows: [{ samples, successes: samples, failures: 0, p50_ms: 100, p95_ms: 200 }],
          rowCount: 1,
        };
      }) as PgConnection["query"],
      transaction: vi.fn() as PgConnection["transaction"],
      withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
      close: vi.fn() as PgConnection["close"],
    };
    const tracker = new PostgresLatencyTracker({ conn });
    const a = await tracker.stats("anthropic");
    const b = await tracker.stats("openai");
    expect(a.samples).toBe(5);
    expect(b.samples).toBe(10);
    expect(calls[0]?.provider).toBe("anthropic");
    expect(calls[1]?.provider).toBe("openai");
  });
});

describe("PostgresLatencyTracker — LatencyTracker contract compat", () => {
  it("satisfies the @crossengin/ai-router LatencyTracker shape", () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const tracker = new PostgresLatencyTracker({ conn });
    const recordFn: (input: {
      providerId: string;
      latencyMs: number;
      success: boolean;
    }) => Promise<void> = tracker.record.bind(tracker);
    const statsFn: (providerId: string) => Promise<unknown> = tracker.stats.bind(tracker);
    expect(typeof recordFn).toBe("function");
    expect(typeof statsFn).toBe("function");
  });
});
