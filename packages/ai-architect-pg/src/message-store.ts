import type { ArchitectMessageRecord } from "@crossengin/ai-architect";
import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA = "meta";
const TABLE = "architect_messages";

export interface AppendMessageInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly turnIndex: number;
  readonly messageIndex: number;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId: string | null;
  readonly toolUses:
    | ReadonlyArray<{ readonly id: string; readonly name: string; readonly input: unknown }>
    | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly costUsd: number | null;
}

interface Row {
  readonly id: string;
  readonly tenant_id: string;
  readonly session_id: string;
  readonly turn_index: number;
  readonly message_index: number;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly tool_call_id: string | null;
  readonly tool_uses: unknown;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly cost_usd: string | null;
  readonly created_at: string;
}

function parseToolUses(
  value: unknown,
): ReadonlyArray<{ id: string; name: string; input: unknown }> | null {
  if (value === null || value === undefined) return null;
  let arr: unknown;
  if (typeof value === "string") {
    try {
      arr = JSON.parse(value);
    } catch {
      return null;
    }
  } else {
    arr = value;
  }
  if (!Array.isArray(arr)) return null;
  const result: Array<{ id: string; name: string; input: unknown }> = [];
  for (const item of arr) {
    if (
      item !== null &&
      typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string" &&
      typeof (item as { name?: unknown }).name === "string"
    ) {
      const o = item as { id: string; name: string; input?: unknown };
      result.push({ id: o.id, name: o.name, input: o.input ?? null });
    }
  }
  return result;
}

function rowToRecord(row: Row): ArchitectMessageRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    turnIndex: row.turn_index,
    messageIndex: row.message_index,
    role: row.role,
    content: row.content,
    toolCallId: row.tool_call_id,
    toolUses: (() => {
      const t = parseToolUses(row.tool_uses);
      return t === null ? null : [...t];
    })(),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: row.cached_input_tokens,
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    createdAt: row.created_at,
  };
}

export class PostgresArchitectMessageStore {
  constructor(private readonly conn: PgConnection) {}

  async append(input: AppendMessageInput): Promise<ArchitectMessageRecord> {
    const sql = `INSERT INTO ${SCHEMA}.${TABLE}
      (tenant_id, session_id, turn_index, message_index, role, content,
       tool_call_id, tool_uses, input_tokens, output_tokens,
       cached_input_tokens, cost_usd)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
      RETURNING *`;
    const result = await this.conn.query<Row>(sql, [
      input.tenantId,
      input.sessionId,
      input.turnIndex,
      input.messageIndex,
      input.role,
      input.content,
      input.toolCallId,
      input.toolUses === null ? null : JSON.stringify(input.toolUses),
      input.inputTokens,
      input.outputTokens,
      input.cachedInputTokens,
      input.costUsd,
    ]);
    const row = result.rows[0];
    if (row === undefined) throw new Error("append message: insert returned no row");
    return rowToRecord(row);
  }

  async listForSession(sessionId: string): Promise<readonly ArchitectMessageRecord[]> {
    const result = await this.conn.query<Row>(
      `SELECT * FROM ${SCHEMA}.${TABLE}
       WHERE session_id = $1
       ORDER BY turn_index ASC, message_index ASC`,
      [sessionId],
    );
    return result.rows.map(rowToRecord);
  }
}
