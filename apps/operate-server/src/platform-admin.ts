import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { PgConnection } from "@crossengin/kernel-pg";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";

import {
  CreateTenantInputSchema,
  TENANT_STATUSES,
  TenantRecordSchema,
  canTransitionTenant,
  deriveSchemaName,
  type CreateTenantInput,
  type TenantRecord,
  type TenantStatus,
} from "./platform-tenants.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const SELECT_COLUMNS =
  "id, slug, name, status, tier, region, schema_name, search_locale, created_at, updated_at";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Thrown when an INSERT hits a unique constraint (slug or schema_name) → maps to 409. */
export class DuplicateTenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateTenantError";
  }
}

export interface TenantListQuery {
  readonly status?: TenantStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TenantListPage {
  readonly data: readonly TenantRecord[];
  readonly nextCursor: string | null;
}

export interface TenantStatusCounts {
  readonly active: number;
  readonly suspended: number;
  readonly archived: number;
  readonly deleted: number;
  readonly total: number;
}

export interface PostgresTenantStoreOptions {
  readonly schema?: string;
}

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

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof DuplicateTenantError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "23505") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /duplicate key|unique constraint|already exists/i.test(message);
}

/** Cross-tenant CRUD over the PLATFORM-WIDE `meta.tenants` registry — plain queries, no RLS. */
export class PostgresTenantStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: PostgresTenantStoreOptions = {}) {
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.schema = schema;
  }

  private get table(): string {
    return `${this.schema}.tenants`;
  }

  rowToTenant(row: Record<string, unknown>): TenantRecord {
    return TenantRecordSchema.parse({
      id: String(row["id"]),
      slug: String(row["slug"]),
      name: String(row["name"]),
      status: String(row["status"]),
      tier: String(row["tier"]),
      region: String(row["region"]),
      schemaName: String(row["schema_name"]),
      searchLocale: String(row["search_locale"]),
      createdAt: isoOf(row["created_at"]),
      updatedAt: isoOf(row["updated_at"]),
    });
  }

  async list(query: TenantListQuery = {}): Promise<TenantListPage> {
    const limit = clampLimit(query.limit);
    const offset = decodeCursor(query.cursor);
    const params: unknown[] = [];
    let where = "";
    if (query.status !== undefined) {
      params.push(query.status);
      where = ` WHERE status = $${params.length}`;
    }
    params.push(limit + 1);
    const limitParam = params.length;
    params.push(offset);
    const offsetParam = params.length;
    const sql =
      `SELECT ${SELECT_COLUMNS} FROM ${this.table}${where}` +
      ` ORDER BY created_at DESC, id LIMIT $${limitParam} OFFSET $${offsetParam}`;
    const result = await this.conn.query(sql, params);
    const rows = result.rows.map((r) => this.rowToTenant(r));
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    return { data, nextCursor: hasMore ? encodeCursor(offset + limit) : null };
  }

  async getById(id: string): Promise<TenantRecord | null> {
    const result = await this.conn.query(
      `SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.rowToTenant(row);
  }

  async getBySlug(slug: string): Promise<TenantRecord | null> {
    const result = await this.conn.query(
      `SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE slug = $1`,
      [slug],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.rowToTenant(row);
  }

  async create(input: CreateTenantInput): Promise<TenantRecord> {
    const schemaName = input.schemaName ?? deriveSchemaName(input.slug);
    const sql =
      `INSERT INTO ${this.table} (slug, name, status, tier, region, schema_name, search_locale)` +
      ` VALUES ($1, $2, 'active', $3, $4, $5, $6) RETURNING ${SELECT_COLUMNS}`;
    try {
      const result = await this.conn.query(sql, [
        input.slug,
        input.name,
        input.tier,
        input.region,
        schemaName,
        input.searchLocale,
      ]);
      const row = result.rows[0];
      if (row === undefined) throw new Error("INSERT did not return a row");
      return this.rowToTenant(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DuplicateTenantError(
          `tenant already exists (slug=${input.slug} schema_name=${schemaName})`,
        );
      }
      throw err;
    }
  }

  async setStatus(id: string, status: TenantStatus): Promise<TenantRecord | null> {
    const result = await this.conn.query(
      `UPDATE ${this.table} SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
      [id, status],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.rowToTenant(row);
  }

  async counts(): Promise<TenantStatusCounts> {
    const result = await this.conn.query(
      `SELECT status, COUNT(*)::int AS count FROM ${this.table} GROUP BY status`,
    );
    const byStatus = { active: 0, suspended: 0, archived: 0, deleted: 0 };
    let total = 0;
    for (const row of result.rows) {
      const status = String(row["status"]) as TenantStatus;
      const count = Number(row["count"]);
      if (status in byStatus) byStatus[status] += count;
      total += count;
    }
    return { ...byStatus, total };
  }
}

export interface PlatformAdminContext {
  readonly store: PostgresTenantStore;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles permitted to manage the platform. Fail-closed: empty ⇒ nobody. */
  readonly adminRoles: ReadonlySet<string>;
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function hasRole(ctx: PlatformAdminContext, principal: ResolvedPrincipal | null): boolean {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])].some((r) => ctx.adminRoles.has(r));
}

/** 401 when unauthenticated, 403 when the caller lacks a platform-admin role, else null (allowed). */
function guard(ctx: PlatformAdminContext, principal: ResolvedPrincipal | null): HandlerOutput | null {
  if (principal === null) return json(401, { error: "authentication_required" });
  if (!hasRole(ctx, principal)) {
    return json(403, { error: "forbidden", detail: "insufficient role" });
  }
  return null;
}

function firstQueryValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : (value as string);
}

function readListQuery(input: Parameters<Handler>[0]): TenantListQuery {
  const query = (input.request as { query?: Record<string, string | string[]> } | undefined)?.query ?? {};
  const statusRaw = firstQueryValue(query["status"]);
  const status =
    statusRaw !== undefined && (TENANT_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as TenantStatus)
      : undefined;
  const limitRaw = firstQueryValue(query["limit"]);
  const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
  const cursor = firstQueryValue(query["cursor"]);
  return { status, limit, cursor };
}

function buildListHandler(ctx: PlatformAdminContext): Handler {
  return async (input) => {
    const denial = guard(ctx, input.principal);
    if (denial !== null) return denial;
    const page = await ctx.store.list(readListQuery(input));
    return json(200, { data: page.data, page: { nextCursor: page.nextCursor } });
  };
}

function buildCreateHandler(ctx: PlatformAdminContext): Handler {
  return async ({ principal, parsedBody }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    const parsed = CreateTenantInputSchema.safeParse(parsedBody ?? {});
    if (!parsed.success) return json(400, { error: "invalid_request", detail: parsed.error.issues });
    try {
      const tenant = await ctx.store.create(parsed.data);
      return json(201, { tenant });
    } catch (err) {
      if (err instanceof DuplicateTenantError) {
        return json(409, { error: "tenant_exists", detail: err.message });
      }
      throw err;
    }
  };
}

function buildGetHandler(ctx: PlatformAdminContext): Handler {
  return async ({ principal, params }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    const tenant = await ctx.store.getById(params["id"] ?? "");
    if (tenant === null) return json(404, { error: "tenant_not_found", detail: params["id"] ?? "" });
    return json(200, { tenant });
  };
}

/** A status-transition handler (suspend / archive / reactivate) gated on `canTransitionTenant`. */
function buildTransitionHandler(ctx: PlatformAdminContext, target: TenantStatus): Handler {
  return async ({ principal, params }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    const id = params["id"] ?? "";
    const current = await ctx.store.getById(id);
    if (current === null) return json(404, { error: "tenant_not_found", detail: id });
    if (!canTransitionTenant(current.status, target)) {
      return json(409, {
        error: "illegal_transition",
        detail: `${current.status} -> ${target}`,
      });
    }
    const tenant = await ctx.store.setStatus(id, target);
    if (tenant === null) return json(404, { error: "tenant_not_found", detail: id });
    return json(200, { tenant });
  };
}

function buildStatsHandler(ctx: PlatformAdminContext): Handler {
  return async ({ principal }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    return json(200, { counts: await ctx.store.counts() });
  };
}

/** The platform super-admin routes to inject via the gateway's `extraRoutes` hook. */
export function buildPlatformAdminRoutes(ctx: PlatformAdminContext): readonly ExtraGatewayRoute[] {
  const v = (
    op: string,
    method: RouteDefinition["method"],
    segs: ReadonlyArray<string | { param: string }>,
    handler: Handler,
  ): ExtraGatewayRoute => ({ route: route(op, method, segs), handler });
  return [
    v("platform.tenants.list", "GET", ["v1", "platform", "tenants"], buildListHandler(ctx)),
    v("platform.tenants.create", "POST", ["v1", "platform", "tenants"], buildCreateHandler(ctx)),
    v("platform.stats", "GET", ["v1", "platform", "stats"], buildStatsHandler(ctx)),
    v("platform.tenants.get", "GET", ["v1", "platform", "tenants", { param: "id" }], buildGetHandler(ctx)),
    v(
      "platform.tenants.suspend",
      "POST",
      ["v1", "platform", "tenants", { param: "id" }, "suspend"],
      buildTransitionHandler(ctx, "suspended"),
    ),
    v(
      "platform.tenants.archive",
      "POST",
      ["v1", "platform", "tenants", { param: "id" }, "archive"],
      buildTransitionHandler(ctx, "archived"),
    ),
    v(
      "platform.tenants.reactivate",
      "POST",
      ["v1", "platform", "tenants", { param: "id" }, "reactivate"],
      buildTransitionHandler(ctx, "active"),
    ),
  ];
}

function route(
  operationId: string,
  method: RouteDefinition["method"],
  segments: ReadonlyArray<string | { param: string }>,
): RouteDefinition {
  const pathSegments: PathSegment[] = segments.map((s) =>
    typeof s === "string" ? { kind: "literal", value: s } : { kind: "parameter", name: s.param, pattern: null },
  );
  return {
    id: `rt_${operationId.replace(/[^a-z0-9]+/gi, "_")}`,
    operationId,
    method,
    pathSegments,
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [],
    rateLimitPolicyId: null,
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}
