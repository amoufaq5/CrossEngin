import type {
  ArchitectProposalDecision,
  ArchitectProposalRecord,
} from "@crossengin/ai-architect";
import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA = "meta";
const TABLE = "architect_proposals";

export interface AppendProposalInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly toolInvocationId: string | null;
  readonly targetPath: string;
  readonly isNew: boolean;
  readonly oldHash: string | null;
  readonly newHash: string;
  readonly entitiesAdded: number;
  readonly entitiesRemoved: number;
  readonly entitiesModified: number;
  readonly decision: ArchitectProposalDecision;
  readonly applied: boolean;
  readonly denialReason: string | null;
}

interface Row {
  readonly id: string;
  readonly tenant_id: string;
  readonly session_id: string;
  readonly tool_invocation_id: string | null;
  readonly target_path: string;
  readonly is_new: boolean;
  readonly old_hash: string | null;
  readonly new_hash: string;
  readonly entities_added: number;
  readonly entities_removed: number;
  readonly entities_modified: number;
  readonly decision: ArchitectProposalDecision;
  readonly applied: boolean;
  readonly denial_reason: string | null;
  readonly proposed_at: string;
  readonly decided_at: string | null;
}

function rowToRecord(row: Row): ArchitectProposalRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    toolInvocationId: row.tool_invocation_id,
    targetPath: row.target_path,
    isNew: row.is_new,
    oldHash: row.old_hash,
    newHash: row.new_hash,
    entitiesAdded: row.entities_added,
    entitiesRemoved: row.entities_removed,
    entitiesModified: row.entities_modified,
    decision: row.decision,
    applied: row.applied,
    denialReason: row.denial_reason,
    proposedAt: row.proposed_at,
    decidedAt: row.decided_at,
  };
}

export class PostgresArchitectProposalStore {
  constructor(private readonly conn: PgConnection) {}

  async append(input: AppendProposalInput): Promise<ArchitectProposalRecord> {
    const sql = `INSERT INTO ${SCHEMA}.${TABLE}
      (tenant_id, session_id, tool_invocation_id, target_path, is_new,
       old_hash, new_hash, entities_added, entities_removed, entities_modified,
       decision, applied, denial_reason, decided_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
      RETURNING *`;
    const result = await this.conn.query<Row>(sql, [
      input.tenantId,
      input.sessionId,
      input.toolInvocationId,
      input.targetPath,
      input.isNew,
      input.oldHash,
      input.newHash,
      input.entitiesAdded,
      input.entitiesRemoved,
      input.entitiesModified,
      input.decision,
      input.applied,
      input.denialReason,
    ]);
    const row = result.rows[0];
    if (row === undefined) throw new Error("append proposal: insert returned no row");
    return rowToRecord(row);
  }

  async listForSession(sessionId: string): Promise<readonly ArchitectProposalRecord[]> {
    const result = await this.conn.query<Row>(
      `SELECT * FROM ${SCHEMA}.${TABLE}
       WHERE session_id = $1
       ORDER BY proposed_at ASC`,
      [sessionId],
    );
    return result.rows.map(rowToRecord);
  }
}
