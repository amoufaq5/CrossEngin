import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresTranscript } from "./transcript.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const SESSION_UUID = "00000000-0000-4000-8000-000000000002";
const MSG_ID = "00000000-0000-4000-8000-000000000003";
const TI_ID = "00000000-0000-4000-8000-000000000004";
const PROP_ID = "00000000-0000-4000-8000-000000000005";
const TS = "2026-05-17T12:00:00.000Z";
const HASH = "a".repeat(64);

interface CapturedCall {
  sql: string;
  params: readonly unknown[] | undefined;
}

function mockConnection(rows: Array<Record<string, unknown>>): {
  conn: PgConnection;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let idx = 0;
  const conn: PgConnection = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });
      const row = rows[idx];
      idx += 1;
      if (row === undefined)
        return { rows: [], rowCount: 0 } as PgQueryResult<Record<string, unknown>>;
      return { rows: [row], rowCount: 1 } as PgQueryResult<Record<string, unknown>>;
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return { conn, calls };
}

describe("PostgresTranscript", () => {
  it("runs a complete lifecycle: start → message → tool → proposal → end", async () => {
    const { conn, calls } = mockConnection([
      // onSessionStart
      {
        id: SESSION_UUID,
        tenant_id: TENANT,
        session_id: "cli-1",
        model: "claude-sonnet-4-6",
        system_prompt_sha256: null,
        started_at: TS,
        ended_at: null,
        turn_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cost_usd: "0",
      },
      // onMessage
      {
        id: MSG_ID,
        tenant_id: TENANT,
        session_id: SESSION_UUID,
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
      },
      // onToolInvocation
      {
        id: TI_ID,
        tenant_id: TENANT,
        session_id: SESSION_UUID,
        message_id: MSG_ID,
        tool_call_id: "tu_1",
        tool_name: "validate_manifest",
        input: { manifest_json: "{}" },
        output: '{"ok":true}',
        is_error: false,
        duration_ms: 5,
        started_at: TS,
      },
      // onProposal
      {
        id: PROP_ID,
        tenant_id: TENANT,
        session_id: SESSION_UUID,
        tool_invocation_id: TI_ID,
        target_path: "/tmp/m.json",
        is_new: true,
        old_hash: null,
        new_hash: HASH,
        entities_added: 1,
        entities_removed: 0,
        entities_modified: 0,
        decision: "interactive_approved",
        applied: true,
        denial_reason: null,
        proposed_at: TS,
        decided_at: TS,
      },
      // onSessionEnd
      {
        id: SESSION_UUID,
        tenant_id: TENANT,
        session_id: "cli-1",
        model: "claude-sonnet-4-6",
        system_prompt_sha256: null,
        started_at: TS,
        ended_at: TS,
        turn_count: 1,
        input_tokens: 12,
        output_tokens: 6,
        cached_input_tokens: 0,
        cost_usd: "0.001",
      },
    ]);
    const tr = new PostgresTranscript(conn);
    const session = await tr.onSessionStart({
      tenantId: TENANT,
      sessionId: "cli-1",
      model: "claude-sonnet-4-6",
      systemPromptSha256: null,
    });
    expect(session.id).toBe(SESSION_UUID);

    const msg = await tr.onMessage({
      turnIndex: 0,
      messageIndex: 0,
      role: "user",
      content: "hi",
    });
    expect(msg.id).toBe(MSG_ID);

    const ti = await tr.onToolInvocation({
      messageId: MSG_ID,
      toolCallId: "tu_1",
      toolName: "validate_manifest",
      input: { manifest_json: "{}" },
      output: '{"ok":true}',
      isError: false,
      durationMs: 5,
    });
    expect(ti.id).toBe(TI_ID);

    const prop = await tr.onProposal({
      toolInvocationId: TI_ID,
      targetPath: "/tmp/m.json",
      isNew: true,
      oldHash: null,
      newHash: HASH,
      entitiesAdded: 1,
      entitiesRemoved: 0,
      entitiesModified: 0,
      decision: "interactive_approved",
      applied: true,
      denialReason: null,
    });
    expect(prop.decision).toBe("interactive_approved");

    const ended = await tr.onSessionEnd({
      turnCount: 1,
      inputTokens: 12,
      outputTokens: 6,
      cachedInputTokens: 0,
      costUsd: 0.001,
    });
    expect(ended?.turnCount).toBe(1);
    expect(ended?.endedAt).toBe(TS);

    expect(calls).toHaveLength(5);
    expect(calls[0]?.sql).toContain("INSERT INTO meta.architect_sessions");
    expect(calls[1]?.sql).toContain("INSERT INTO meta.architect_messages");
    expect(calls[2]?.sql).toContain("INSERT INTO meta.architect_tool_invocations");
    expect(calls[3]?.sql).toContain("INSERT INTO meta.architect_proposals");
    expect(calls[4]?.sql).toContain("UPDATE meta.architect_sessions");
  });

  it("throws if onMessage is called before onSessionStart", async () => {
    const { conn } = mockConnection([]);
    const tr = new PostgresTranscript(conn);
    await expect(
      tr.onMessage({ turnIndex: 0, messageIndex: 0, role: "user", content: "hi" }),
    ).rejects.toThrow(/onSessionStart/);
  });

  it("onSessionEnd returns null when no session was started", async () => {
    const { conn } = mockConnection([]);
    const tr = new PostgresTranscript(conn);
    expect(
      await tr.onSessionEnd({
        turnCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0,
      }),
    ).toBeNull();
  });
});
