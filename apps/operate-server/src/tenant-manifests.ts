import type { PgConnection } from "@crossengin/kernel-pg";
import { withTenantContext } from "@crossengin/operate-runtime-pg";
import { z } from "zod";

export const MANIFEST_PROPOSAL_STATUSES = ["draft", "active", "archived"] as const;
export type ManifestProposalStatus = (typeof MANIFEST_PROPOSAL_STATUSES)[number];

const MANIFEST_PROPOSAL_SOURCES = ["ai", "manual"] as const;
export type ManifestProposalSource = (typeof MANIFEST_PROPOSAL_SOURCES)[number];

export const TenantManifestRecordSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    name: z.string().min(1),
    description: z.string(),
    manifest: z.record(z.unknown()),
    manifestHash: z.string().min(1),
    status: z.enum(MANIFEST_PROPOSAL_STATUSES),
    source: z.enum(MANIFEST_PROPOSAL_SOURCES),
    providerLabel: z.string().nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    activatedAt: z.string().datetime({ offset: true }).nullable(),
    reviewStatus: z.enum(["not_required", "pending", "approved", "rejected"]),
    reviewNotes: z.string().nullable(),
    reviewedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export type TenantManifestRecord = z.infer<typeof TenantManifestRecordSchema>;

export const CreateManifestProposalInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(8000).default(""),
    manifest: z.record(z.unknown()),
    manifestHash: z.string().min(1),
    source: z.enum(MANIFEST_PROPOSAL_SOURCES),
    providerLabel: z.string().nullable().optional(),
  })
  .strict();

export type CreateManifestProposalInput = z.infer<typeof CreateManifestProposalInputSchema>;

const MANIFEST_STATUS_TRANSITIONS: Readonly<
  Record<ManifestProposalStatus, readonly ManifestProposalStatus[]>
> = {
  draft: ["active", "archived"],
  active: ["archived"],
  archived: ["active"],
};

export function canTransitionManifest(
  from: ManifestProposalStatus,
  to: ManifestProposalStatus,
): boolean {
  return MANIFEST_STATUS_TRANSITIONS[from].includes(to);
}

export interface ManifestSummary {
  readonly entityCount: number;
  readonly roleCount: number;
  readonly relationCount: number;
  readonly workflowCount: number;
  readonly entities: readonly { name: string; label: string; fieldCount: number }[];
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function countOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const rec = recordOf(value);
  return rec === null ? 0 : Object.keys(rec).length;
}

function labelOf(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  const rec = recordOf(value);
  const en = rec?.["en"];
  if (typeof en === "string" && en.length > 0) return en;
  return fallback;
}

export function manifestSummary(manifest: Record<string, unknown>): ManifestSummary {
  // The kernel manifest carries entities as an array of {name, fields, ...}; a generated or
  // hand-written doc may instead key them by name. Summarize either shape.
  const rawEntities = manifest["entities"];
  const entries: readonly [string, unknown][] = Array.isArray(rawEntities)
    ? rawEntities.map((value, index): [string, unknown] => {
        const name = recordOf(value)?.["name"];
        return [typeof name === "string" && name.length > 0 ? name : `entity_${index.toString()}`, value];
      })
    : Object.entries(recordOf(rawEntities) ?? {});
  const entities = entries.map(([name, value]) => {
    const entity = recordOf(value) ?? {};
    return { name, label: labelOf(entity["label"], name), fieldCount: countOf(entity["fields"]) };
  });
  return {
    entityCount: entities.length,
    roleCount: countOf(manifest["roles"]),
    relationCount: countOf(manifest["relations"]),
    workflowCount: countOf(manifest["workflows"]),
    entities,
  };
}

export interface TenantManifestListQuery {
  readonly status?: ManifestProposalStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TenantManifestListPage {
  readonly data: readonly TenantManifestRecord[];
  readonly nextCursor: string | null;
}

export interface TenantManifestSource {
  activeManifestFor(tenantId: string): Promise<Record<string, unknown> | null>;
}

export interface PostgresTenantManifestStoreOptions {
  readonly schema?: string;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const SELECT_COLUMNS =
  "id, tenant_id, name, description, manifest, manifest_hash, status, source, provider_label, " +
  "created_at, updated_at, activated_at, review_status, review_notes, reviewed_at";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
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

/**
 * Per-tenant manifest proposals over `meta.operate_tenant_manifests`. The table
 * carries tenant RLS, so every method runs inside `withTenantContext` (which
 * binds `app.current_tenant_id` for the transaction) AND binds `tenant_id` as a
 * WHERE predicate — defense in depth.
 */
export class PostgresTenantManifestStore implements TenantManifestSource {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: PostgresTenantManifestStoreOptions = {}) {
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

  rowToRecord(row: Record<string, unknown>): TenantManifestRecord {
    return TenantManifestRecordSchema.parse({
      id: String(row["id"]),
      tenantId: String(row["tenant_id"]),
      name: String(row["name"]),
      description: String(row["description"] ?? ""),
      manifest: manifestOf(row["manifest"]),
      manifestHash: String(row["manifest_hash"]),
      status: String(row["status"]),
      source: String(row["source"]),
      providerLabel: row["provider_label"] == null ? null : String(row["provider_label"]),
      createdAt: isoOf(row["created_at"]),
      updatedAt: isoOf(row["updated_at"]),
      activatedAt: row["activated_at"] == null ? null : isoOf(row["activated_at"]),
      reviewStatus: String(row["review_status"] ?? "not_required"),
      reviewNotes: row["review_notes"] == null ? null : String(row["review_notes"]),
      reviewedAt: row["reviewed_at"] == null ? null : isoOf(row["reviewed_at"]),
    });
  }

  async create(tenantId: string, input: CreateManifestProposalInput): Promise<TenantManifestRecord> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `INSERT INTO ${this.table}` +
        ` (tenant_id, name, description, manifest, manifest_hash, status, source, provider_label)` +
        ` VALUES ($1, $2, $3, $4::jsonb, $5, 'draft', $6, $7) RETURNING ${SELECT_COLUMNS}`;
      const result = await tx.query(sql, [
        tenantId,
        input.name,
        input.description,
        JSON.stringify(input.manifest),
        input.manifestHash,
        input.source,
        input.providerLabel ?? null,
      ]);
      const row = result.rows[0];
      if (row === undefined) throw new Error("INSERT did not return a row");
      return this.rowToRecord(row);
    });
  }

  async list(tenantId: string, query: TenantManifestListQuery = {}): Promise<TenantManifestListPage> {
    const limit = clampLimit(query.limit);
    const offset = decodeCursor(query.cursor);
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const params: unknown[] = [tenantId];
      let where = " WHERE tenant_id = $1";
      if (query.status !== undefined) {
        params.push(query.status);
        where += ` AND status = $${params.length}`;
      }
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

  async getById(tenantId: string, id: string): Promise<TenantManifestRecord | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query(
        `SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      const row = result.rows[0];
      return row === undefined ? null : this.rowToRecord(row);
    });
  }

  async setStatus(
    tenantId: string,
    id: string,
    status: ManifestProposalStatus,
  ): Promise<TenantManifestRecord | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const activatedClause = status === "active" ? ", activated_at = now()" : "";
      const result = await tx.query(
        `UPDATE ${this.table} SET status = $3, updated_at = now()${activatedClause}` +
          ` WHERE tenant_id = $1 AND id = $2 RETURNING ${SELECT_COLUMNS}`,
        [tenantId, id, status],
      );
      const row = result.rows[0];
      return row === undefined ? null : this.rowToRecord(row);
    });
  }

  /** Demote-then-promote in ONE tenant transaction, so exactly one row is `active` per tenant. */
  async activate(tenantId: string, id: string): Promise<TenantManifestRecord | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      // Serialize activations per tenant: under READ COMMITTED, two concurrent activates of
      // different drafts would each see zero rows to demote and commit two 'active' rows.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('operate_tenant_manifests'), hashtext($1))", [
        tenantId,
      ]);
      await tx.query(
        `UPDATE ${this.table} SET status = 'archived', updated_at = now()` +
          ` WHERE tenant_id = $1 AND status = 'active' AND id <> $2`,
        [tenantId, id],
      );
      const result = await tx.query(
        `UPDATE ${this.table} SET status = 'active', updated_at = now(), activated_at = now()` +
          ` WHERE tenant_id = $1 AND id = $2 RETURNING ${SELECT_COLUMNS}`,
        [tenantId, id],
      );
      const row = result.rows[0];
      return row === undefined ? null : this.rowToRecord(row);
    });
  }

  async activeManifestFor(tenantId: string): Promise<Record<string, unknown> | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query(
        `SELECT manifest FROM ${this.table} WHERE tenant_id = $1 AND status = 'active'` +
          ` ORDER BY activated_at DESC NULLS LAST, created_at DESC LIMIT 1`,
        [tenantId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return manifestOf(row["manifest"]);
    });
  }
}
