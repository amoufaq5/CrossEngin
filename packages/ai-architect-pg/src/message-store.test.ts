import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresArchitectMessageStore } from "./message-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const SESSION = "00000000-0000-4000-8000-000000000002";
const MSG_ID = "00000000-0000-4000-8000-000000000003";
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

function messageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MSG_ID,
    tenant_id: TENANT,
    session_id: SESSION,
    turn_index: 0,
    message_index: 0,
    role: "user",
    content: "hi",
    tool_call_id: null,
    tool_uses: null,
    input_tokens: null,
    output_tokens: null,
    cached_input_tokens: null,
    cost_usd: null,
    created_at: TS,
    ...overrides,
  };
}

describe("PostgresArchitectMessageStore.append", () => {
  it("inserts a user message and returns the record", async () => {
    const conn = mockConnection((sql, params) => {
      expect(sql).toContain("INSERT INTO meta.architect_messages");
      expect(params?.[4]).toBe("user");
      expect(params?.[5]).toBe("hi");
      return { rows: [messageRow()], rowCount: 1 };
    });
    const store = new PostgresArchitectMessageStore(conn);
    const record = await store.append({
      tenantId: TENANT,
      sessionId: SESSION,
      turnIndex: 0,
      messageIndex: 0,
      role: "user",
      content: "hi",
      toolCallId: null,
      toolUses: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      costUsd: null,
    });
    expect(record.role).toBe("user");
    expect(record.content).toBe("hi");
  });

  it("serializes toolUses to JSONB and parses on read-back", async () => {
    const conn = mockConnection((_, params) => {
      const json = params?.[7] as string;
      expect(json).toContain("tu_1");
      return {
        rows: [
          messageRow({
            role: "assistant",
            content: "ok",
            tool_uses: [{ id: "tu_1", name: "validate_manifest", input: { x: 1 } }],
            input_tokens: 10,
            output_tokens: 5,
            cached_input_tokens: 0,
            cost_usd: "0.001",
          }),
        ],
        rowCount: 1,
      };
    });
    const store = new PostgresArchitectMessageStore(conn);
    const record = await store.append({
      tenantId: TENANT,
      sessionId: SESSION,
      turnIndex: 0,
      messageIndex: 1,
      role: "assistant",
      content: "ok",
      toolCallId: null,
      toolUses: [{ id: "tu_1", name: "validate_manifest", input: { x: 1 } }],
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      costUsd: 0.001,
    });
    expect(record.toolUses?.[0]?.id).toBe("tu_1");
    expect(record.costUsd).toBe(0.001);
  });

  it("parses tool_uses returned as a string (Postgres can return JSONB as text)", async () => {
    const conn = mockConnection(() => ({
      rows: [
        messageRow({
          tool_uses: JSON.stringify([{ id: "tu_2", name: "hash_manifest", input: {} }]),
        }),
      ],
      rowCount: 1,
    }));
    const store = new PostgresArchitectMessageStore(conn);
    const record = await store.append({
      tenantId: TENANT,
      sessionId: SESSION,
      turnIndex: 0,
      messageIndex: 0,
      role: "assistant",
      content: "",
      toolCallId: null,
      toolUses: [{ id: "tu_2", name: "hash_manifest", input: {} }],
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      costUsd: null,
    });
    expect(record.toolUses?.[0]?.id).toBe("tu_2");
  });
});

describe("PostgresArchitectMessageStore.listForSession", () => {
  it("returns messages ordered by turn_index then message_index", async () => {
    const conn = mockConnection((sql) => {
      expect(sql).toContain("ORDER BY turn_index ASC, message_index ASC");
      return {
        rows: [
          messageRow({ turn_index: 0, message_index: 0 }),
          messageRow({ turn_index: 0, message_index: 1, role: "assistant" }),
        ],
        rowCount: 2,
      };
    });
    const store = new PostgresArchitectMessageStore(conn);
    const list = await store.listForSession(SESSION);
    expect(list).toHaveLength(2);
    expect(list[1]?.role).toBe("assistant");
  });
});
