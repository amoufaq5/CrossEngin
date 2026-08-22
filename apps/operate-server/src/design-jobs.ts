import type { PgConnection } from "@crossengin/kernel-pg";
import { withTenantContext } from "@crossengin/operate-runtime-pg";
import { z } from "zod";

export const DESIGN_JOB_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type DesignJobStatus = (typeof DESIGN_JOB_STATUSES)[number];

export const DESIGN_JOB_PHASES = [
  "queued",
  "generating",
  "validating",
  "retrying",
  "done",
  "error",
] as const;
export type DesignJobPhase = (typeof DESIGN_JOB_PHASES)[number];

export const DesignJobRecordSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    status: z.enum(DESIGN_JOB_STATUSES),
    phase: z.enum(DESIGN_JOB_PHASES),
    attempt: z.number().int().min(0),
    maxAttempts: z.number().int().min(1),
    name: z.string(),
    description: z.string(),
    outputChars: z.number().int().min(0),
    issues: z.array(z.string()).readonly(),
    proposalId: z.string().uuid().nullable(),
    providerLabel: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type DesignJobRecord = z.infer<typeof DesignJobRecordSchema>;

export interface CreateDesignJobInput {
  readonly name: string;
  readonly description: string;
  readonly maxAttempts: number;
}

export interface DesignJobProgressInput {
  readonly status?: DesignJobStatus;
  readonly phase?: DesignJobPhase;
  readonly attempt?: number;
  readonly outputChars?: number;
  readonly issues?: readonly string[];
}

export interface DesignJobStore {
  create(tenantId: string, input: CreateDesignJobInput): Promise<DesignJobRecord>;
  getById(tenantId: string, id: string): Promise<DesignJobRecord | null>;
  updateProgress(
    tenantId: string,
    id: string,
    input: DesignJobProgressInput,
  ): Promise<DesignJobRecord | null>;
  succeed(
    tenantId: string,
    id: string,
    input: { proposalId: string; providerLabel: string | null },
  ): Promise<DesignJobRecord | null>;
  fail(
    tenantId: string,
    id: string,
    input: { error: string; issues?: readonly string[]; providerLabel?: string | null },
  ): Promise<DesignJobRecord | null>;
  deleteExpired(olderThanIso: string): Promise<number>;
}

export interface PostgresDesignJobStoreOptions {
  readonly schema?: string;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const SELECT_COLUMNS =
  "id, tenant_id, status, phase, attempt, max_attempts, name, description, output_chars, issues, proposal_id, provider_label, error, created_at, updated_at";

/** Terminal statuses the retention sweep is allowed to reap; an in-flight run is never deleted. */
const SWEEPABLE_STATUS_LIST = "'succeeded', 'failed'";

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function intOf(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** node-postgres yields JSONB as a parsed value, but a scripted/raw driver may hand back the text form. */
function issuesOf(value: unknown): string[] {
  const parsed: unknown = typeof value === "string" ? safeJsonParse(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => (typeof entry === "string" ? entry : String(entry)));
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Fixed literal column map — a progress key never reaches SQL as caller-supplied text. */
const PROGRESS_COLUMNS = {
  status: "status",
  phase: "phase",
  attempt: "attempt",
  outputChars: "output_chars",
  issues: "issues",
} as const;

const PROGRESS_KEYS = ["status", "phase", "attempt", "outputChars", "issues"] as const;

/**
 * Durable, cross-replica record of an in-flight AI design run over
 * `meta.operate_design_jobs`, so a polling wizard sees live phase/attempt
 * progress instead of blocking on one long request. The table carries tenant
 * RLS, so every per-job method runs inside `withTenantContext` (which binds
 * `app.current_tenant_id` for the transaction) AND binds `tenant_id` as a WHERE
 * predicate — defense in depth. `deleteExpired` is the one exception: it is a
 * platform-wide retention sweep across tenants, so it deliberately runs outside
 * any tenant context (like `PostgresTenantSource`).
 */
export class PostgresDesignJobStore implements DesignJobStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: PostgresDesignJobStoreOptions = {}) {
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.schema = schema;
  }

  private get table(): string {
    return `${this.schema}.operate_design_jobs`;
  }

  rowToRecord(row: Record<string, unknown>): DesignJobRecord {
    return DesignJobRecordSchema.parse({
      id: String(row["id"]),
      tenantId: String(row["tenant_id"]),
      status: String(row["status"]),
      phase: String(row["phase"]),
      attempt: intOf(row["attempt"], 0),
      maxAttempts: intOf(row["max_attempts"], 1),
      name: String(row["name"] ?? ""),
      description: String(row["description"] ?? ""),
      outputChars: intOf(row["output_chars"], 0),
      issues: issuesOf(row["issues"]),
      proposalId: row["proposal_id"] == null ? null : String(row["proposal_id"]),
      providerLabel: row["provider_label"] == null ? null : String(row["provider_label"]),
      error: row["error"] == null ? null : String(row["error"]),
      createdAt: isoOf(row["created_at"]),
      updatedAt: isoOf(row["updated_at"]),
    });
  }

  async create(tenantId: string, input: CreateDesignJobInput): Promise<DesignJobRecord> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `INSERT INTO ${this.table}` +
        ` (tenant_id, status, phase, attempt, max_attempts, name, description, output_chars, issues)` +
        ` VALUES ($1, 'queued', 'queued', 0, $2, $3, $4, 0, '[]'::jsonb)` +
        ` RETURNING ${SELECT_COLUMNS}`;
      const result = await tx.query(sql, [tenantId, input.maxAttempts, input.name, input.description]);
      const row = result.rows[0];
      if (row === undefined) throw new Error("INSERT did not return a row");
      return this.rowToRecord(row);
    });
  }

  async getById(tenantId: string, id: string): Promise<DesignJobRecord | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query(
        `SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      const row = result.rows[0];
      return row === undefined ? null : this.rowToRecord(row);
    });
  }

  async updateProgress(
    tenantId: string,
    id: string,
    input: DesignJobProgressInput,
  ): Promise<DesignJobRecord | null> {
    const params: unknown[] = [tenantId, id];
    const sets: string[] = [];
    for (const key of PROGRESS_KEYS) {
      const value = input[key];
      if (value === undefined) continue;
      if (key === "issues") {
        params.push(JSON.stringify([...(value as readonly string[])]));
        sets.push(`${PROGRESS_COLUMNS[key]} = $${params.length}::jsonb`);
        continue;
      }
      params.push(value);
      sets.push(`${PROGRESS_COLUMNS[key]} = $${params.length}`);
    }
    if (sets.length === 0) return this.getById(tenantId, id);
    sets.push("updated_at = now()");
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE ${this.table} SET ${sets.join(", ")}` +
          ` WHERE tenant_id = $1 AND id = $2 RETURNING ${SELECT_COLUMNS}`,
        params,
      );
      const row = result.rows[0];
      return row === undefined ? null : this.rowToRecord(row);
    });
  }

  async succeed(
    tenantId: string,
    id: string,
    input: { proposalId: string; providerLabel: string | null },
  ): Promise<DesignJobRecord | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE ${this.table} SET status = 'succeeded', phase = 'done', proposal_id = $3,` +
          ` provider_label = $4, updated_at = now()` +
          ` WHERE tenant_id = $1 AND id = $2 RETURNING ${SELECT_COLUMNS}`,
        [tenantId, id, input.proposalId, input.providerLabel],
      );
      const row = result.rows[0];
      return row === undefined ? null : this.rowToRecord(row);
    });
  }

  async fail(
    tenantId: string,
    id: string,
    input: { error: string; issues?: readonly string[]; providerLabel?: string | null },
  ): Promise<DesignJobRecord | null> {
    const params: unknown[] = [tenantId, id, input.error];
    const sets: string[] = ["status = 'failed'", "phase = 'error'", "error = $3"];
    if (input.issues !== undefined) {
      params.push(JSON.stringify([...input.issues]));
      sets.push(`issues = $${params.length}::jsonb`);
    }
    if (input.providerLabel !== undefined) {
      params.push(input.providerLabel);
      sets.push(`provider_label = $${params.length}`);
    }
    sets.push("updated_at = now()");
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE ${this.table} SET ${sets.join(", ")}` +
          ` WHERE tenant_id = $1 AND id = $2 RETURNING ${SELECT_COLUMNS}`,
        params,
      );
      const row = result.rows[0];
      return row === undefined ? null : this.rowToRecord(row);
    });
  }

  /** Platform-wide retention sweep — spans tenants, so it must NOT run under a tenant RLS context. */
  async deleteExpired(olderThanIso: string): Promise<number> {
    const result = await this.conn.query(
      `DELETE FROM ${this.table} WHERE updated_at < $1 AND status IN (${SWEEPABLE_STATUS_LIST})`,
      [olderThanIso],
    );
    return result.rowCount;
  }
}
