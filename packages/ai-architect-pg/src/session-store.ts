import type { ArchitectSessionRecord } from "@crossengin/ai-architect";
import { isoInstant, requireIsoInstant, type PgConnection } from "@crossengin/kernel-pg";

import { withTenantContext } from "./tenant-context.js";

const SCHEMA = "meta";
const TABLE = "architect_sessions";

export interface StartSessionInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly model: string;
  readonly systemPromptSha256: string | null;
}

export interface EndSessionInput {
  /** The session's tenant: the context the update runs under and a predicate beside it. */
  readonly tenantId: string;
  readonly id: string;
  readonly turnCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costUsd: number;
}

interface Row {
  readonly id: string;
  readonly tenant_id: string;
  readonly session_id: string;
  readonly model: string;
  readonly system_prompt_sha256: string | null;
  readonly started_at: unknown;
  readonly ended_at: unknown;
  readonly turn_count: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_input_tokens: number;
  readonly cost_usd: string;
}

function rowToRecord(row: Row): ArchitectSessionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    model: row.model,
    systemPromptSha256: row.system_prompt_sha256,
    startedAt: requireIsoInstant(row.started_at, "started_at"),
    endedAt: isoInstant(row.ended_at),
    turnCount: row.turn_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: row.cached_input_tokens,
    costUsd: Number(row.cost_usd),
  };
}

export class PostgresArchitectSessionStore {
  constructor(private readonly conn: PgConnection) {}

  async startSession(input: StartSessionInput): Promise<ArchitectSessionRecord> {
    const sql = `INSERT INTO ${SCHEMA}.${TABLE}
      (tenant_id, session_id, model, system_prompt_sha256)
      VALUES ($1, $2, $3, $4)
      RETURNING *`;
    const result = await withTenantContext(this.conn, input.tenantId, (tx) =>
      tx.query<Row>(sql, [input.tenantId, input.sessionId, input.model, input.systemPromptSha256]),
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("startSession: insert returned no row");
    }
    return rowToRecord(row);
  }

  async endSession(input: EndSessionInput): Promise<ArchitectSessionRecord | null> {
    const sql = `UPDATE ${SCHEMA}.${TABLE}
      SET ended_at = now(),
          turn_count = $2,
          input_tokens = $3,
          output_tokens = $4,
          cached_input_tokens = $5,
          cost_usd = $6
      WHERE id = $1 AND tenant_id = $7
      RETURNING *`;
    const result = await withTenantContext(this.conn, input.tenantId, (tx) =>
      tx.query<Row>(sql, [
        input.id,
        input.turnCount,
        input.inputTokens,
        input.outputTokens,
        input.cachedInputTokens,
        input.costUsd,
        input.tenantId,
      ]),
    );
    const row = result.rows[0];
    return row !== undefined ? rowToRecord(row) : null;
  }

  async getById(tenantId: string, id: string): Promise<ArchitectSessionRecord | null> {
    const result = await withTenantContext(this.conn, tenantId, (tx) =>
      tx.query<Row>(`SELECT * FROM ${SCHEMA}.${TABLE} WHERE id = $1 AND tenant_id = $2`, [id, tenantId]),
    );
    const row = result.rows[0];
    return row !== undefined ? rowToRecord(row) : null;
  }

  async listForTenant(input: {
    readonly tenantId: string;
    readonly limit?: number;
  }): Promise<readonly ArchitectSessionRecord[]> {
    const limit = input.limit ?? 100;
    const result = await withTenantContext(this.conn, input.tenantId, (tx) =>
      tx.query<Row>(
        `SELECT * FROM ${SCHEMA}.${TABLE}
         WHERE tenant_id = $1
         ORDER BY started_at DESC
         LIMIT $2`,
        [input.tenantId, limit],
      ),
    );
    return result.rows.map(rowToRecord);
  }
}
