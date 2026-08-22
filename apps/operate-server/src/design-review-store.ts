import type { PgConnection } from "@crossengin/kernel-pg";
import { withTenantContext } from "@crossengin/operate-runtime-pg";
import { z } from "zod";

const REVIEW_STATUSES = ["not_required", "pending", "approved", "rejected"] as const;

const ReviewStatusSchema = z.enum(REVIEW_STATUSES);

const DesignReviewRecordSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    name: z.string().min(1),
    description: z.string(),
    manifest: z.record(z.unknown()),
    manifestHash: z.string().min(1),
    status: z.string().min(1),
    reviewStatus: ReviewStatusSchema,
    reviewedBy: z.string().nullable(),
    reviewedAt: z.string().datetime({ offset: true }).nullable(),
    reviewNotes: z.string().nullable(),
    providerLabel: z.string().nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export interface DesignReviewRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description: string;
  readonly manifest: Record<string, unknown>;
  readonly manifestHash: string;
  readonly status: string;
  readonly reviewStatus: "not_required" | "pending" | "approved" | "rejected";
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly reviewNotes: string | null;
  readonly providerLabel: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DesignReviewListQuery {
  readonly reviewStatus?: DesignReviewRecord["reviewStatus"];
  readonly tenantId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface DesignReviewListPage {
  readonly data: readonly DesignReviewRecord[];
  readonly nextCursor: string | null;
}

export interface DesignReviewCounts {
  readonly pending: number;
  readonly approved: number;
  readonly rejected: number;
  readonly notRequired: number;
  readonly total: number;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const SELECT_COLUMNS =
  "id, tenant_id, name, description, manifest, manifest_hash, status, review_status, reviewed_by, reviewed_at, review_notes, provider_label, created_at, updated_at";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Elevates the transaction to the cross-tenant review scope the RLS policy on
 * `meta.operate_tenant_manifests` recognizes
 * (`... OR current_setting('app.platform_review', true) = 'on'`). The `true`
 * third argument makes the setting *transaction-local*, so the elevation is
 * released with the transaction and can never leak onto a pooled connection.
 */
const SET_PLATFORM_REVIEW_SQL = "SELECT set_config('app.platform_review', 'on', true)";

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function intOf(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** node-postgres yields JSONB as a parsed object, but a scripted/raw driver may hand back the text form. */
function manifestOf(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return recordOf(JSON.parse(value)) ?? {};
    } catch {
      return {};
    }
  }
  return recordOf(value) ?? {};
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.length === 0) return 0;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const match = /^o:(\d+)$/.exec(decoded);
    if (match === null) return 0;
    return Number.parseInt(match[1] ?? "0", 10);
  } catch {
    return 0;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

/**
 * Runs `fn` inside a transaction carrying the platform review elevation, the
 * explicit and auditable opt-in the RLS policy requires for cross-tenant reads
 * and decisions. Modelled on `withTenantContext`: a `SELECT set_config(...)`
 * with `is_local => true`, never a session-wide `SET`.
 */
export async function withPlatformReview<T>(
  conn: PgConnection,
  fn: (tx: PgConnection) => Promise<T>,
): Promise<T> {
  return conn.transaction(async (tx) => {
    await tx.query(SET_PLATFORM_REVIEW_SQL);
    return fn(tx);
  });
}

interface PostgresDesignReviewStoreOptions {
  readonly schema?: string;
}

/**
 * The platform operator's view of AI-generated manifest proposals across every
 * tenant, over `meta.operate_tenant_manifests`. Cross-tenant methods
 * (list/getById/counts/approve/reject) run under `withPlatformReview`;
 * `markPending` and `reviewStatusFor` are a tenant's own operations and run
 * under `withTenantContext` with `tenant_id` bound as a WHERE predicate too —
 * defense in depth. The store never gates a transition: the route layer owns
 * the review state machine.
 */
export class PostgresDesignReviewStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: PostgresDesignReviewStoreOptions = {}) {
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.schema = schema;
  }

  private get table(): string {
    return `${this.schema}.operate_tenant_manifests`;
  }

  private rowToRecord(row: Record<string, unknown>): DesignReviewRecord {
    return DesignReviewRecordSchema.parse({
      id: String(row["id"]),
      tenantId: String(row["tenant_id"]),
      name: String(row["name"]),
      description: String(row["description"] ?? ""),
      manifest: manifestOf(row["manifest"]),
      manifestHash: String(row["manifest_hash"]),
      status: String(row["status"]),
      reviewStatus: String(row["review_status"]),
      reviewedBy: row["reviewed_by"] == null ? null : String(row["reviewed_by"]),
      reviewedAt: row["reviewed_at"] == null ? null : isoOf(row["reviewed_at"]),
      reviewNotes: row["review_notes"] == null ? null : String(row["review_notes"]),
      providerLabel: row["provider_label"] == null ? null : String(row["provider_label"]),
      createdAt: isoOf(row["created_at"]),
      updatedAt: isoOf(row["updated_at"]),
    });
  }

  async list(query: DesignReviewListQuery = {}): Promise<DesignReviewListPage> {
    const limit = clampLimit(query.limit);
    const offset = decodeCursor(query.cursor);
    return withPlatformReview(this.conn, async (tx) => {
      const params: unknown[] = [];
      const conditions: string[] = [];
      if (query.reviewStatus !== undefined) {
        params.push(query.reviewStatus);
        conditions.push(`review_status = $${params.length}`);
      }
      if (query.tenantId !== undefined) {
        params.push(query.tenantId);
        conditions.push(`tenant_id = $${params.length}`);
      }
      const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
      params.push(limit + 1);
      const limitParam = params.length;
      params.push(offset);
      const offsetParam = params.length;
      const sql =
        `SELECT ${SELECT_COLUMNS} FROM ${this.table}${where}` +
        ` ORDER BY created_at DESC, id LIMIT $${limitParam} OFFSET $${offsetParam}`;
      const result = await tx.query(sql, params);
      const rows = result.rows.map((r) => this.rowToRecord(r));
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      return { data, nextCursor: hasMore ? encodeCursor(offset + limit) : null };
    });
  }

  async getById(id: string): Promise<DesignReviewRecord | null> {
    return withPlatformReview(this.conn, async (tx) => {
      const result = await tx.query(`SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE id = $1`, [id]);
      const row = result.rows[0];
      return row === undefined ? null : this.rowToRecord(row);
    });
  }

  async counts(): Promise<DesignReviewCounts> {
    return withPlatformReview(this.conn, async (tx) => {
      const result = await tx.query(
        `SELECT review_status, count(*)::int AS n FROM ${this.table} GROUP BY review_status`,
      );
      const buckets: Record<(typeof REVIEW_STATUSES)[number], number> = {
        not_required: 0,
        pending: 0,
        approved: 0,
        rejected: 0,
      };
      for (const row of result.rows) {
        const parsed = ReviewStatusSchema.safeParse(String(row["review_status"]));
        if (!parsed.success) continue;
        buckets[parsed.data] += intOf(row["n"], 0);
      }
      return {
        pending: buckets.pending,
        approved: buckets.approved,
        rejected: buckets.rejected,
        notRequired: buckets.not_required,
        total: buckets.pending + buckets.approved + buckets.rejected + buckets.not_required,
      };
    });
  }

  async approve(
    id: string,
    input: { reviewedBy: string; notes?: string | null },
  ): Promise<DesignReviewRecord | null> {
    return this.decide(id, "approved", input);
  }

  async reject(
    id: string,
    input: { reviewedBy: string; notes?: string | null },
  ): Promise<DesignReviewRecord | null> {
    return this.decide(id, "rejected", input);
  }

  private async decide(
    id: string,
    reviewStatus: "approved" | "rejected",
    input: { reviewedBy: string; notes?: string | null },
  ): Promise<DesignReviewRecord | null> {
    return withPlatformReview(this.conn, async (tx) => {
      const result = await tx.query(
        `UPDATE ${this.table} SET review_status = $2, reviewed_by = $3, reviewed_at = now(),` +
          ` review_notes = $4, updated_at = now() WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
        [id, reviewStatus, input.reviewedBy, input.notes ?? null],
      );
      const row = result.rows[0];
      return row === undefined ? null : this.rowToRecord(row);
    });
  }

  async markPending(tenantId: string, id: string): Promise<DesignReviewRecord | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE ${this.table} SET review_status = 'pending', updated_at = now()` +
          ` WHERE tenant_id = $1 AND id = $2 RETURNING ${SELECT_COLUMNS}`,
        [tenantId, id],
      );
      const row = result.rows[0];
      return row === undefined ? null : this.rowToRecord(row);
    });
  }

  async reviewStatusFor(
    tenantId: string,
    id: string,
  ): Promise<DesignReviewRecord["reviewStatus"] | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query(
        `SELECT review_status FROM ${this.table} WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return ReviewStatusSchema.parse(String(row["review_status"]));
    });
  }
}
