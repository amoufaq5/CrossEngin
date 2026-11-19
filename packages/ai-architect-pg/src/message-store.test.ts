import { describe, expect, it } from "vitest";

import { tenantScopedConnection, type StatementHandler } from "./test-fakes.js";
import { PostgresArchitectMessageStore } from "./message-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const SESSION = "00000000-0000-4000-8000-000000000002";
const MSG_ID = "00000000-0000-4000-8000-000000000003";
const TS = "2026-05-17T12:00:00.000Z";

function mockConnection(handler: StatementHandler): ReturnType<typeof tenantScopedConnection> {
  return tenantScopedConnection(handler);
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
    // The insert ran inside a transaction that set the row's own tenant first (M-17).
    expect(conn.statements.map((st) => st.tenant)).toEqual([TENANT]);
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
    const list = await store.listForSession(TENANT, SESSION);
    expect(list).toHaveLength(2);
    expect(list[1]?.role).toBe("assistant");
  });
});

describe("PostgresArchitectMessageStore runs every statement under the row's tenant (M-17)", () => {
  it("scopes the read by predicate as well as by context", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    await new PostgresArchitectMessageStore(conn).listForSession(TENANT, SESSION);
    expect(conn.statements).toHaveLength(1);
    expect(conn.statements[0]?.tenant).toBe(TENANT);
    expect(conn.statements[0]?.sql).toContain("session_id = $1 AND tenant_id = $2");
    expect(conn.statements[0]?.params).toEqual([SESSION, TENANT]);
  });
});
