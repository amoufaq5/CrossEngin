import type { ArchitectToolInvocationRecord } from "@crossengin/ai-architect";
import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA = "meta";
const TABLE = "architect_tool_invocations";

export interface AppendToolInvocationInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly messageId: string | null;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly output: string;
  readonly isError: boolean;
  readonly durationMs: number | null;
}

interface Row {
  readonly id: string;
  readonly tenant_id: string;
  readonly session_id: string;
  readonly message_id: string | null;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly input: unknown;
  readonly output: string;
  readonly is_error: boolean;
  readonly duration_ms: number | null;
  readonly started_at: string;
}

function parseJsonb(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function rowToRecord(row: Row): ArchitectToolInvocationRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    messageId: row.message_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    input: parseJsonb(row.input),
    output: row.output,
    isError: row.is_error,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
  };
}

export class PostgresArchitectToolInvocationStore {
  constructor(private readonly conn: PgConnection) {}

  async append(input: AppendToolInvocationInput): Promise<ArchitectToolInvocationRecord> {
    const sql = `INSERT INTO ${SCHEMA}.${TABLE}
      (tenant_id, session_id, message_id, tool_call_id, tool_name, input,
       output, is_error, duration_ms)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
      RETURNING *`;
    const result = await this.conn.query<Row>(sql, [
      input.tenantId,
      input.sessionId,
      input.messageId,
      input.toolCallId,
      input.toolName,
      JSON.stringify(input.input ?? null),
      input.output,
      input.isError,
      input.durationMs,
    ]);
    const row = result.rows[0];
    if (row === undefined) throw new Error("append tool invocation: insert returned no row");
    return rowToRecord(row);
  }

  async listForSession(sessionId: string): Promise<readonly ArchitectToolInvocationRecord[]> {
    const result = await this.conn.query<Row>(
      `SELECT * FROM ${SCHEMA}.${TABLE}
       WHERE session_id = $1
       ORDER BY started_at ASC`,
      [sessionId],
    );
    return result.rows.map(rowToRecord);
  }
}
