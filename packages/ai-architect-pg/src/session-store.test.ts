import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresArchitectSessionStore } from "./session-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const SESSION_UUID = "00000000-0000-4000-8000-000000000002";
const TS = "2026-05-17T12:00:00.000Z";

function mockConnection(
  handler: (
    sql: string,
    params: readonly unknown[] | undefined,
  ) => PgQueryResult<Record<string, unknown>>,
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) =>
      handler(sql, params),
    ) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION_UUID,
    tenant_id: TENANT,
    session_id: "cli-abc",
    model: "claude-sonnet-4-6",
    system_prompt_sha256: null,
    started_at: TS,
    ended_at: null,
    turn_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cost_usd: "0",
    ...overrides,
  };
}

describe("PostgresArchitectSessionStore.startSession", () => {
  it("inserts a row and returns the parsed record", async () => {
    const conn = mockConnection((sql, params) => {
      expect(sql).toContain("INSERT INTO meta.architect_sessions");
      expect(params).toEqual([TENANT, "cli-abc", "claude-sonnet-4-6", null]);
      return { rows: [sessionRow()], rowCount: 1 };
    });
    const store = new PostgresArchitectSessionStore(conn);
    const record = await store.startSession({
      tenantId: TENANT,
      sessionId: "cli-abc",
      model: "claude-sonnet-4-6",
      systemPromptSha256: null,
    });
    expect(record.sessionId).toBe("cli-abc");
    expect(record.costUsd).toBe(0);
  });

  it("threads the system prompt hash through", async () => {
    const conn = mockConnection((_, params) => {
      expect(params?.[3]).toBe("a".repeat(64));
      return { rows: [sessionRow({ system_prompt_sha256: "a".repeat(64) })], rowCount: 1 };
    });
    const store = new PostgresArchitectSessionStore(conn);
    const record = await store.startSession({
      tenantId: TENANT,
      sessionId: "cli-abc",
      model: "claude-sonnet-4-6",
      systemPromptSha256: "a".repeat(64),
    });
    expect(record.systemPromptSha256).toBe("a".repeat(64));
  });

  it("throws if INSERT returns no row", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const store = new PostgresArchitectSessionStore(conn);
    await expect(
      store.startSession({
        tenantId: TENANT,
        sessionId: "cli-abc",
        model: "claude-sonnet-4-6",
        systemPromptSha256: null,
      }),
    ).rejects.toThrow(/insert returned no row/);
  });
});

describe("PostgresArchitectSessionStore.endSession", () => {
  it("UPDATEs with the supplied totals", async () => {
    const conn = mockConnection((sql, params) => {
      expect(sql).toContain("UPDATE meta.architect_sessions");
      expect(sql).toContain("ended_at = now()");
      expect(params).toEqual([SESSION_UUID, 3, 100, 50, 10, 0.001]);
      return {
        rows: [
          sessionRow({
            ended_at: TS,
            turn_count: 3,
            input_tokens: 100,
            output_tokens: 50,
            cached_input_tokens: 10,
            cost_usd: "0.001",
          }),
        ],
        rowCount: 1,
      };
    });
    const store = new PostgresArchitectSessionStore(conn);
    const record = await store.endSession({
      id: SESSION_UUID,
      turnCount: 3,
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 10,
      costUsd: 0.001,
    });
    expect(record?.turnCount).toBe(3);
    expect(record?.costUsd).toBe(0.001);
    expect(record?.endedAt).toBe(TS);
  });

  it("returns null when the id does not exist", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const store = new PostgresArchitectSessionStore(conn);
    expect(
      await store.endSession({
        id: SESSION_UUID,
        turnCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0,
      }),
    ).toBeNull();
  });
});

describe("PostgresArchitectSessionStore.getById", () => {
  it("returns the record when present", async () => {
    const conn = mockConnection(() => ({ rows: [sessionRow()], rowCount: 1 }));
    const store = new PostgresArchitectSessionStore(conn);
    expect((await store.getById(SESSION_UUID))?.id).toBe(SESSION_UUID);
  });

  it("returns null when absent", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const store = new PostgresArchitectSessionStore(conn);
    expect(await store.getById(SESSION_UUID)).toBeNull();
  });
});

describe("PostgresArchitectSessionStore.getBySessionId", () => {
  it("looks up by (tenant_id, session_id) compound key", async () => {
    const conn = mockConnection((sql, params) => {
      expect(sql).toContain("WHERE tenant_id = $1 AND session_id = $2");
      expect(params).toEqual([TENANT, "cli-abc"]);
      return { rows: [sessionRow()], rowCount: 1 };
    });
    const store = new PostgresArchitectSessionStore(conn);
    const record = await store.getBySessionId({
      tenantId: TENANT,
      sessionId: "cli-abc",
    });
    expect(record?.sessionId).toBe("cli-abc");
  });

  it("returns null when no row matches", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const store = new PostgresArchitectSessionStore(conn);
    expect(await store.getBySessionId({ tenantId: TENANT, sessionId: "missing" })).toBeNull();
  });
});

describe("PostgresArchitectSessionStore.listForTenant", () => {
  it("returns records ordered by started_at DESC with limit", async () => {
    const conn = mockConnection((sql, params) => {
      expect(sql).toContain("ORDER BY started_at DESC");
      expect(params).toEqual([TENANT, 5]);
      return { rows: [sessionRow(), sessionRow({ session_id: "cli-2" })], rowCount: 2 };
    });
    const store = new PostgresArchitectSessionStore(conn);
    const list = await store.listForTenant({ tenantId: TENANT, limit: 5 });
    expect(list).toHaveLength(2);
  });

  it("defaults limit to 100", async () => {
    const conn = mockConnection((_, params) => {
      expect(params?.[1]).toBe(100);
      return { rows: [], rowCount: 0 };
    });
    const store = new PostgresArchitectSessionStore(conn);
    await store.listForTenant({ tenantId: TENANT });
  });
});
