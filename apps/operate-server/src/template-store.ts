import type { PgConnection } from "@crossengin/kernel-pg";
import {
  NotificationTemplateSchema,
  TEMPLATE_STATUSES,
  type NotificationTemplate,
  type TemplateContent,
  type TemplateStatus,
  type TemplateVariable,
} from "@crossengin/notifications";
import { withTenantContext } from "@crossengin/operate-runtime-pg";

export interface TemplateStoreOptions {
  readonly schema?: string;
}

export interface TemplateQuery {
  readonly templateId: string;
  readonly locale: string;
  readonly channel: string;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

const REGIONED_LOCALE_RE = /^([a-z]{2})-[A-Z]{2}$/;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * INVARIANT: the only strings templated into SQL besides the validated schema
 * name are status literals drawn from the shipped `TEMPLATE_STATUSES` enum and
 * the table's own unique-constraint name — a fixed catalog identifier. Every
 * other value (tenant ids, template ids, locales, channels, versions, JSON
 * payloads, timestamps, limits) is a bound parameter.
 */
function statusLiteral(status: TemplateStatus): string {
  if (!TEMPLATE_STATUSES.includes(status)) {
    throw new Error(`unknown template status: ${JSON.stringify(status)}`);
  }
  return `'${status}'`;
}

const APPROVED_LITERAL = statusLiteral("approved");

const UNIQUE_CONSTRAINT = "notification_templates_tenant_template_locale_version_key";

const SELECT_COLUMNS =
  "ntpl_id, tenant_id, template_id, version, locale, channel, category, status, content," +
  " variables, body_size_bytes, created_at, created_by, approved_at, approved_by," +
  " deprecated_at, superseded_by_template_id";

const INSERT_COLUMNS =
  "tenant_id, ntpl_id, template_id, version, locale, channel, category, status, content," +
  " variables, body_size_bytes, created_at, created_by, approved_at, approved_by," +
  " deprecated_at, superseded_by_template_id";

const INSERT_VALUES =
  "$1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16, $17";

const CONFLICT_UPDATE =
  "content = EXCLUDED.content, variables = EXCLUDED.variables, status = EXCLUDED.status," +
  " category = EXCLUDED.category, channel = EXCLUDED.channel," +
  " body_size_bytes = EXCLUDED.body_size_bytes, approved_at = EXCLUDED.approved_at," +
  " approved_by = EXCLUDED.approved_by, deprecated_at = EXCLUDED.deprecated_at," +
  " superseded_by_template_id = EXCLUDED.superseded_by_template_id";

/**
 * Highest version wins, compared per semver component: `string_to_array` splits
 * the TEXT column into an `int[]`, whose ordering is element-wise numeric, so
 * `10.0.0` sorts above `9.0.0` — a plain `ORDER BY version DESC` gets that
 * backwards because it compares the text `'1'` against `'9'`.
 */
const RESOLUTION_ORDER =
  "ORDER BY (tenant_id IS NULL) ASC, string_to_array(version, '.')::int[] DESC";

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  return isoOf(value);
}

function textOrNull(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function contentOf(value: unknown): TemplateContent {
  if (typeof value === "string") return JSON.parse(value) as TemplateContent;
  return value as TemplateContent;
}

function variablesOf(value: unknown): readonly TemplateVariable[] {
  if (typeof value === "string") return JSON.parse(value) as readonly TemplateVariable[];
  if (value == null) return [];
  return value as readonly TemplateVariable[];
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

/** `en-GB` → `en`; a locale with no region part has no fallback to try. */
export function languageOnlyLocale(locale: string): string | null {
  const match = REGIONED_LOCALE_RE.exec(locale);
  if (match === null) return null;
  return match[1] ?? null;
}

export function templateFromRow(row: Record<string, unknown>): NotificationTemplate {
  return NotificationTemplateSchema.parse({
    id: String(row["ntpl_id"]),
    tenantId: textOrNull(row["tenant_id"]),
    templateId: String(row["template_id"]),
    version: String(row["version"]),
    locale: String(row["locale"]),
    channel: String(row["channel"]),
    category: String(row["category"]),
    status: String(row["status"]),
    content: contentOf(row["content"]),
    variables: variablesOf(row["variables"]),
    bodySizeBytes: Number(row["body_size_bytes"]),
    createdAt: isoOf(row["created_at"]),
    createdBy: String(row["created_by"]),
    approvedAt: isoOrNull(row["approved_at"]),
    approvedBy: textOrNull(row["approved_by"]),
    deprecatedAt: isoOrNull(row["deprecated_at"]),
    supersededByTemplateId: textOrNull(row["superseded_by_template_id"]),
  });
}

export function tryTemplateFromRow(row: Record<string, unknown>): NotificationTemplate | null {
  try {
    return templateFromRow(row);
  } catch {
    return null;
  }
}

function parseRows(rows: readonly Record<string, unknown>[]): readonly NotificationTemplate[] {
  const templates: NotificationTemplate[] = [];
  for (const row of rows) {
    const template = tryTemplateFromRow(row);
    if (template !== null) templates.push(template);
  }
  return templates;
}

/**
 * Override resolution for notification templates over
 * `meta.notification_templates`. The platform ships a built-in default body for
 * every template in code; a row here is an *authored override* that should win
 * over that default — either the tenant's own, or a platform-wide one authored
 * by an operator (`tenant_id IS NULL`).
 *
 * INVARIANT — the read/write asymmetry: reads match
 * `(tenant_id = $1 OR tenant_id IS NULL)`, because a platform-wide row
 * legitimately belongs to no tenant and is visible to everyone (the table's RLS
 * policy says exactly that). Writes are always `tenant_id = $1` — this store
 * never authors a platform row, so a tenant can neither publish a template for
 * everyone nor overwrite the operator's default. Every method still runs inside
 * `withTenantContext`, which binds `app.current_tenant_id` for the transaction,
 * so RLS confines the read half regardless of what the predicate says.
 */
export class PostgresTemplateStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: TemplateStoreOptions = {}) {
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.schema = schema;
  }

  private get table(): string {
    return `${this.schema}.notification_templates`;
  }

  private get findSql(): string {
    return (
      `SELECT ${SELECT_COLUMNS} FROM ${this.table}` +
      ` WHERE (tenant_id = $1 OR tenant_id IS NULL)` +
      ` AND template_id = $2 AND locale = $3 AND channel = $4` +
      ` AND status = ${APPROVED_LITERAL}` +
      ` ${RESOLUTION_ORDER} LIMIT 1`
    );
  }

  /**
   * Resolution happens in SQL, not in TypeScript: precedence (tenant row before
   * platform row) and recency (highest semver) are both an ORDER BY over the
   * single `LIMIT 1` candidate set, so the database never ships rows the caller
   * would only throw away. The language-only retry is the one thing TypeScript
   * decides, and only after the exact-locale query has actually missed.
   */
  async find(tenantId: string, query: TemplateQuery): Promise<NotificationTemplate | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const exact = await tx.query(this.findSql, [
        tenantId,
        query.templateId,
        query.locale,
        query.channel,
      ]);
      const row = exact.rows[0];
      if (row !== undefined) return tryTemplateFromRow(row);
      const fallbackLocale = languageOnlyLocale(query.locale);
      if (fallbackLocale === null) return null;
      const fallback = await tx.query(this.findSql, [
        tenantId,
        query.templateId,
        fallbackLocale,
        query.channel,
      ]);
      const fallbackRow = fallback.rows[0];
      if (fallbackRow === undefined) return null;
      return tryTemplateFromRow(fallbackRow);
    });
  }

  /**
   * INVARIANT: the caller's tenant, not the record's, owns the write. A template
   * carrying a null or foreign `tenantId` is rejected before any SQL is issued —
   * a tenant may not author the platform-wide default nor another tenant's
   * override, and RLS would reject the row anyway, so failing here keeps the
   * refusal explicit instead of surfacing as a policy violation.
   */
  async upsert(tenantId: string, template: NotificationTemplate): Promise<boolean> {
    if (template.tenantId === null) {
      throw new Error("cannot author a platform-wide template: tenantId is null");
    }
    if (template.tenantId !== tenantId) {
      throw new Error(
        `template tenantId ${JSON.stringify(template.tenantId)} does not match caller tenant`,
      );
    }
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `INSERT INTO ${this.table} (${INSERT_COLUMNS})` +
        ` VALUES (${INSERT_VALUES})` +
        ` ON CONFLICT ON CONSTRAINT ${UNIQUE_CONSTRAINT} DO UPDATE SET ${CONFLICT_UPDATE}`;
      const result = await tx.query(sql, [
        tenantId,
        template.id,
        template.templateId,
        template.version,
        template.locale,
        template.channel,
        template.category,
        template.status,
        JSON.stringify(template.content),
        JSON.stringify(template.variables),
        template.bodySizeBytes,
        template.createdAt,
        template.createdBy,
        template.approvedAt,
        template.approvedBy,
        template.deprecatedAt,
        template.supersededByTemplateId,
      ]);
      return result.rowCount > 0;
    });
  }

  async listForTenant(
    tenantId: string,
    limit?: number,
  ): Promise<readonly NotificationTemplate[]> {
    const batch = clampLimit(limit);
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `SELECT ${SELECT_COLUMNS} FROM ${this.table}` +
        ` WHERE tenant_id = $1` +
        ` ORDER BY created_at DESC, ntpl_id DESC LIMIT $2`;
      const result = await tx.query(sql, [tenantId, batch]);
      return parseRows(result.rows);
    });
  }
}
