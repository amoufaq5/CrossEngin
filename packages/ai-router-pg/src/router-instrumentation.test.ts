import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { RouterInstrumentationEvent } from "@crossengin/ai-router";
import { describe, expect, it, vi } from "vitest";

import { PostgresRouterInstrumentation } from "./router-instrumentation.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

interface Capture {
  sql: string;
  params: readonly unknown[] | undefined;
}

function mockConnection(capture?: Capture[]): PgConnection {
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

function event(overrides: Partial<RouterInstrumentationEvent> = {}): RouterInstrumentationEvent {
  return {
    kind: "llm_call_started",
    tenantId: TENANT,
    sessionId: "sess-1",
    task: "executor",
    providerId: "anthropic",
    modelId: "claude-sonnet-4-6",
    occurredAt: "2026-05-20T12:00:00.000Z",
    durationMs: null,
    attributes: { attemptIndex: 0, totalChoices: 2 },
    ...overrides,
  };
}

describe("PostgresRouterInstrumentation.onEvent", () => {
  it("INSERTs into meta.llm_call_traces", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(capture);
    const inst = new PostgresRouterInstrumentation({ conn });
    await inst.onEvent(event());
    expect(capture.length).toBe(1);
    expect(capture[0]?.sql).toContain("INSERT INTO meta.llm_call_traces");
  });

  it("threads the 9 row columns as params in the documented order", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(capture);
    const inst = new PostgresRouterInstrumentation({ conn });
    await inst.onEvent(event({ durationMs: 123 }));
    expect(capture[0]?.params).toEqual([
      TENANT,
      "anthropic",
      "claude-sonnet-4-6",
      "executor",
      "sess-1",
      "llm_call_started",
      "2026-05-20T12:00:00.000Z",
      123,
      JSON.stringify({ attemptIndex: 0, totalChoices: 2 }),
    ]);
  });

  it("supports llm_call_completed events with cost + token attributes", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(capture);
    const inst = new PostgresRouterInstrumentation({ conn });
    await inst.onEvent(
      event({
        kind: "llm_call_completed",
        durationMs: 450,
        attributes: {
          costUsd: 0.0042,
          inputTokens: 1024,
          outputTokens: 512,
          cachedInputTokens: 256,
          attempts: 1,
        },
      }),
    );
    expect(capture[0]?.params?.[5]).toBe("llm_call_completed");
    expect(capture[0]?.params?.[7]).toBe(450);
    const attrs = JSON.parse(capture[0]?.params?.[8] as string) as Record<string, unknown>;
    expect(attrs["costUsd"]).toBe(0.0042);
    expect(attrs["inputTokens"]).toBe(1024);
  });

  it("supports llm_call_failed events with error + willFallback attributes", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(capture);
    const inst = new PostgresRouterInstrumentation({ conn });
    await inst.onEvent(
      event({
        kind: "llm_call_failed",
        durationMs: 9999,
        attributes: {
          errorKind: "rate_limit_error",
          errorMessage: "throttled",
          attempts: 3,
          willFallback: true,
        },
      }),
    );
    expect(capture[0]?.params?.[5]).toBe("llm_call_failed");
    const attrs = JSON.parse(capture[0]?.params?.[8] as string) as Record<string, unknown>;
    expect(attrs["errorKind"]).toBe("rate_limit_error");
    expect(attrs["willFallback"]).toBe(true);
  });

  it("serializes attributes via JSON.stringify (no leakage of native objects)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(capture);
    const inst = new PostgresRouterInstrumentation({ conn });
    await inst.onEvent(
      event({
        attributes: {
          nested: { deep: { value: 42 } },
          nullValue: null,
          booleanValue: true,
        },
      }),
    );
    const attrs = JSON.parse(capture[0]?.params?.[8] as string) as Record<string, unknown>;
    expect((attrs["nested"] as { deep: { value: number } }).deep.value).toBe(42);
    expect(attrs["nullValue"]).toBeNull();
    expect(attrs["booleanValue"]).toBe(true);
  });

  it("threads null durationMs through (started events have no duration)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(capture);
    const inst = new PostgresRouterInstrumentation({ conn });
    await inst.onEvent(event({ durationMs: null }));
    expect(capture[0]?.params?.[7]).toBeNull();
  });

  it("preserves the verbatim ISO-8601 occurredAt", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(capture);
    const inst = new PostgresRouterInstrumentation({ conn });
    await inst.onEvent(event({ occurredAt: "2026-12-31T23:59:59.999Z" }));
    expect(capture[0]?.params?.[6]).toBe("2026-12-31T23:59:59.999Z");
  });

  it("issues exactly one INSERT per event (no batching / no extra round-trips)", async () => {
    const capture: Capture[] = [];
    const conn = mockConnection(capture);
    const inst = new PostgresRouterInstrumentation({ conn });
    await inst.onEvent(event());
    await inst.onEvent(event({ kind: "llm_call_completed" }));
    await inst.onEvent(event({ kind: "llm_call_failed" }));
    expect(capture.length).toBe(3);
  });

  it("propagates PG errors (caller can decide swallow-or-throw)", async () => {
    const conn: PgConnection = {
      query: vi.fn(async () => {
        throw new Error("connection lost");
      }) as PgConnection["query"],
      transaction: vi.fn() as PgConnection["transaction"],
      withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
      close: vi.fn() as PgConnection["close"],
    };
    const inst = new PostgresRouterInstrumentation({ conn });
    await expect(inst.onEvent(event())).rejects.toThrow("connection lost");
  });
});

describe("PostgresRouterInstrumentation — RouterInstrumentation contract compat", () => {
  it("satisfies the @crossengin/ai-router RouterInstrumentation shape", () => {
    const conn = mockConnection();
    const inst = new PostgresRouterInstrumentation({ conn });
    const onEvent: (event: RouterInstrumentationEvent) => Promise<void> = inst.onEvent.bind(inst);
    expect(typeof onEvent).toBe("function");
  });
});
