import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresArchitectToolInvocationStore } from "./tool-invocation-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const SESSION = "00000000-0000-4000-8000-000000000002";
const TS = "2026-05-17T12:00:00.000Z";

function mockConnection(
  handler: (sql: string, params: readonly unknown[] | undefined) => PgQueryResult<Record<string, unknown>>,
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => handler(sql, params)) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

function invocationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    tenant_id: TENANT,
    session_id: SESSION,
    message_id: null,
    tool_call_id: "tu_1",
    tool_name: "validate_manifest",
    input: { manifest_json: "{}" },
    output: "{\"ok\":true}",
    is_error: false,
    duration_ms: 4,
    started_at: TS,
    ...overrides,
  };
}

describe("PostgresArchitectToolInvocationStore.append", () => {
  it("inserts and returns the record with parsed JSONB input", async () => {
    const conn = mockConnection((sql, params) => {
      expect(sql).toContain("INSERT INTO meta.architect_tool_invocations");
      expect(params?.[5]).toBe(JSON.stringify({ manifest_json: "{}" }));
      return { rows: [invocationRow()], rowCount: 1 };
    });
    const store = new PostgresArchitectToolInvocationStore(conn);
    const record = await store.append({
      tenantId: TENANT,
      sessionId: SESSION,
      messageId: null,
      toolCallId: "tu_1",
      toolName: "validate_manifest",
      input: { manifest_json: "{}" },
      output: "{\"ok\":true}",
      isError: false,
      durationMs: 4,
    });
    expect(record.toolName).toBe("validate_manifest");
    expect(record.input).toEqual({ manifest_json: "{}" });
  });

  it("preserves isError + durationMs", async () => {
    const conn = mockConnection(() => ({
      rows: [
        invocationRow({
          is_error: true,
          duration_ms: 50,
          output: "{\"error\":\"boom\"}",
        }),
      ],
      rowCount: 1,
    }));
    const store = new PostgresArchitectToolInvocationStore(conn);
    const record = await store.append({
      tenantId: TENANT,
      sessionId: SESSION,
      messageId: null,
      toolCallId: "tu_1",
      toolName: "validate_manifest",
      input: {},
      output: "{\"error\":\"boom\"}",
      isError: true,
      durationMs: 50,
    });
    expect(record.isError).toBe(true);
    expect(record.durationMs).toBe(50);
  });

  it("parses input returned as a JSON string", async () => {
    const conn = mockConnection(() => ({
      rows: [invocationRow({ input: JSON.stringify({ x: 1 }) })],
      rowCount: 1,
    }));
    const store = new PostgresArchitectToolInvocationStore(conn);
    const record = await store.append({
      tenantId: TENANT,
      sessionId: SESSION,
      messageId: null,
      toolCallId: "tu_1",
      toolName: "x",
      input: { x: 1 },
      output: "",
      isError: false,
      durationMs: null,
    });
    expect(record.input).toEqual({ x: 1 });
  });
});

describe("PostgresArchitectToolInvocationStore.listForSession", () => {
  it("returns invocations ordered by started_at ASC", async () => {
    const conn = mockConnection((sql) => {
      expect(sql).toContain("ORDER BY started_at ASC");
      return { rows: [invocationRow(), invocationRow({ tool_call_id: "tu_2" })], rowCount: 2 };
    });
    const store = new PostgresArchitectToolInvocationStore(conn);
    const list = await store.listForSession(SESSION);
    expect(list).toHaveLength(2);
    expect(list[1]?.toolCallId).toBe("tu_2");
  });
});
