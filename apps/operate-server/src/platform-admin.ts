import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { PgConnection } from "@crossengin/kernel-pg";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import { actionRequiresFourEyes, type LifecycleAction } from "@crossengin/tenant-lifecycle";
import { lifecycleEventFor, type PostgresLifecycleEventStore } from "@crossengin/tenant-lifecycle-pg";
import { z } from "zod";

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

/**
 * Derived from `TENANT_STATUSES` rather than listed, since ADR-0334 — this was four hand-written
 * keys, and narrowing the two tenant-status vocabularies into one added a fifth state that the
 * literal silently would not have counted. A tally that omits a status reports a smaller `total`
 * than the rows it summed, which is the quiet kind of wrong: the console would show four numbers
 * that no longer add up and nothing would say which state went missing.
 */
export type TenantStatusCounts = Readonly<Record<TenantStatus, number>> & {
  readonly total: number;
};

/** Zero for every declared status, so a status with no rows reads as 0 rather than as absent. */
function emptyTenantStatusCounts(): Record<TenantStatus, number> {
  return Object.fromEntries(TENANT_STATUSES.map((s) => [s, 0])) as Record<
    TenantStatus,
    number
  >;
}

export interface PostgresTenantStoreOptions {
  readonly schema?: string;
}

/**
 * A guarded status change that landed: the row as it now stands, and the state it was moved out of.
 *
 * The second field is not a convenience. A lifecycle event's `fromState` is a required, non-defaulted
 * field of the permanent record (ADR-0317's rule), and the only place that knows it is the statement
 * whose predicate matched it.
 */
export interface TenantTransition {
  readonly tenant: TenantRecord;
  readonly previousStatus: TenantStatus;
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

  /**
   * A status change whose **source** state is re-asserted inside the `UPDATE` predicate — the row is
   * the lock (ADR-0321), and stronger than reading the status first because a caller cannot defeat
   * it by reusing what it read.
   *
   * `null` means no row matched, which conflates "no such tenant" with "the tenant is not in one of
   * `from`" on purpose: both mean the caller's premise was wrong, and the caller that needs to tell
   * them apart can read the row. Used by the deletion flow, where an unguarded `setStatus` would let
   * a rejection restore a tenant that a console suspension had meanwhile moved somewhere else.
   *
   * **It reports the state it moved the row out of**, because the lifecycle trail's `fromState` is
   * that state and nothing else can supply it: `RETURNING` answers with the row as it now stands,
   * and `PENDING_DELETION_SOURCES` has more than one member, so the predicate's candidate list does
   * not determine which one matched. Read under `FOR UPDATE` in the same transaction as the write,
   * which is what makes the figure the trail records the same figure the predicate matched — a read
   * on its own connection would leave a window in which the trail disagrees with the row, and
   * Postgres has no `RETURNING OLD` before 18 against a floor of 14.
   */
  async transitionStatus(
    id: string,
    to: TenantStatus,
    from: readonly TenantStatus[],
  ): Promise<TenantTransition | null> {
    if (from.length === 0) return null;
    const placeholders = from.map((_s, i) => `$${(i + 3).toString()}`).join(", ");
    return this.conn.transaction(async (tx) => {
      const before = await tx.query<Record<string, unknown>>(
        `SELECT status FROM ${this.table} WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const previous = before.rows[0];
      if (previous === undefined) return null;
      const result = await tx.query(
        `UPDATE ${this.table} SET status = $2, updated_at = now()` +
          ` WHERE id = $1 AND status IN (${placeholders}) RETURNING ${SELECT_COLUMNS}`,
        [id, to, ...from],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      // Parsed rather than cast: the column's CHECK still lists the seven states ADR-0334 narrowed
      // to five, so a row holding `trial` must read as a finding here and not be carried into a
      // lifecycle event the contract would then refuse one layer later.
      const previousStatus = String(previous["status"]);
      if (!(TENANT_STATUSES as readonly string[]).includes(previousStatus)) {
        throw new Error(
          `${this.table}.status holds ${JSON.stringify(previousStatus)}, which is not a` +
            " TENANT_STATUSES member — the column's CHECK is wider than the contract",
        );
      }
      return { tenant: this.rowToTenant(row), previousStatus: previousStatus as TenantStatus };
    });
  }

  async counts(): Promise<TenantStatusCounts> {
    const result = await this.conn.query(
      `SELECT status, COUNT(*)::int AS count FROM ${this.table} GROUP BY status`,
    );
    const byStatus = emptyTenantStatusCounts();
    let total = 0;
    for (const row of result.rows) {
      const status = String(row["status"]);
      const count = Number(row["count"]);
      // A status the contract does not declare still counts toward `total`, so the figures add up
      // even against a database holding a value the CHECK was widened past — which is exactly the
      // state a half-applied migration leaves, since widening this CHECK is `unreconciled` on a
      // populated deployment (ADR-0330) and is applied by hand.
      if (status in byStatus) byStatus[status as TenantStatus] += count;
      total += count;
    }
    return { ...byStatus, total };
  }
}

/**
 * Which lifecycle action a console transition *is* — a **total map over `TenantStatus`**, keyed on
 * the target state, so a sixth state is a compile error rather than a console button that records
 * nothing.
 *
 * `null` is a declaration that the console does not reach that state, and it is checked against
 * `TENANT_STATUS_TRANSITIONS` rather than asserted: no set in that map targets `pending_deletion` or
 * `deleted`, each for its own reason. `deleted` is the Article 17 flow's terminus. `pending_deletion`
 * is reached by *verifying* a deletion request — four-eyes, a named verifier, an Article 12(3)
 * deadline — so a console button that set it would be a second path to the same state under weaker
 * controls, and `deletion-request-routes` records that transition itself.
 *
 * That absence is also what keeps this route four-eyes-free: `actionRequiresFourEyes` demands
 * approval for `schedule_deletion` under `platform_admin`, which is precisely the pair a
 * `pending_deletion: "schedule_deletion"` entry would create — and this route collects no approver,
 * so `lifecycleEventFor` would refuse every such transition. A test pins the implication rather than
 * the entry, so adding one fails with the reason rather than at the first click.
 */
export const CONSOLE_ACTION: Readonly<Record<TenantStatus, LifecycleAction | null>> = Object.freeze({
  active: "activate",
  suspended: "suspend",
  archived: "archive",
  pending_deletion: null,
  deleted: null,
});

/** The console actions that need no approver under `platform_admin` — i.e. all of them, asserted. */
export function consoleActionsNeedNoApprover(): readonly LifecycleAction[] {
  return TENANT_STATUSES.map((s) => CONSOLE_ACTION[s])
    .filter((a): a is LifecycleAction => a !== null)
    .filter((a) => actionRequiresFourEyes(a, "platform_admin"));
}

/**
 * The body of a console status transition. `reason` is **required**, and that is a caller-visible
 * change: the route took no body at all before.
 *
 * `LifecycleEvent.reason` is `z.string().min(1)` with no default, and defaulting it here would put
 * `"(none given)"` in the permanent record of why a tenant lost access — ADR-0317's silence
 * deciding what a record says. Required unconditionally rather than only when a trail store is
 * configured, because an API whose accepted shape depends on deployment wiring is worse than one
 * that asks for one more field.
 */
export const TransitionTenantBodySchema = z
  .object({ reason: z.string().min(1).max(500) })
  .strict();

export interface PlatformAdminContext {
  readonly store: PostgresTenantStore;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles permitted to manage the platform. Fail-closed: empty ⇒ nobody. */
  readonly adminRoles: ReadonlySet<string>;
  /**
   * Where a console transition is recorded as a lifecycle event. Optional, so a deployment without
   * it still transitions tenants — and the response **says which**, because a trail quietly not
   * written is indistinguishable from a tenant that never existed.
   *
   * Appended **after** the status write, which is the authoritative act, and a failure is reported
   * rather than thrown: the tenant really is suspended, and a 5xx would say otherwise.
   */
  readonly lifecycleEvents?: PostgresLifecycleEventStore;
  /** Event ids. A UUID, because the column is `UUID`; injectable so a test can name the row. */
  readonly newEventId?: () => string;
  readonly clock?: () => Date;
  readonly onLifecycleError?: (err: unknown, action: LifecycleAction) => void;
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

/**
 * Records a console transition on the lifecycle trail. Never fails the request.
 *
 * Three answers, not two: `null` is "this deployment keeps no trail", `false` is "it keeps one and
 * this transition is not in it", `true` is recorded. Collapsing the first two would put back in the
 * response the confusion the table exists to resolve.
 *
 * `fromState` is the status the gate above read and `canTransitionTenant` approved — the same value,
 * not a second read. The write is a `setStatus` with no source predicate, so a concurrent change
 * between the two is possible and pre-dates this: the trail then records the transition the console
 * believed it was making, which is also what the 200 reports.
 */
async function recordConsoleTransition(
  ctx: PlatformAdminContext,
  input: {
    readonly tenantId: string;
    readonly action: LifecycleAction;
    readonly fromState: TenantStatus;
    readonly reason: string;
    readonly actorUserId: string;
  },
): Promise<boolean | null> {
  const store = ctx.lifecycleEvents;
  if (store === undefined) return null;
  const at = (ctx.clock ?? ((): Date => new Date()))().toISOString();
  try {
    await store.append(
      lifecycleEventFor({
        id: (ctx.newEventId ?? ((): string => crypto.randomUUID()))(),
        tenantId: input.tenantId,
        action: input.action,
        fromState: input.fromState,
        // The console *is* the platform admin acting. None of the three console actions requires an
        // approver under this trigger, which `consoleActionsNeedNoApprover` asserts — so no approval
        // is fabricated, and none is silently omitted either.
        trigger: "platform_admin",
        occurredAt: at,
        reason: input.reason,
        actorUserId: input.actorUserId,
      }),
    );
    return true;
  } catch (err) {
    ctx.onLifecycleError?.(err, input.action);
    console.error(
      `[platform] lifecycle ${input.action} for ${input.tenantId} not recorded:` +
        ` ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** A status-transition handler (suspend / archive / reactivate) gated on `canTransitionTenant`. */
function buildTransitionHandler(ctx: PlatformAdminContext, target: TenantStatus): Handler {
  return async ({ principal, params, parsedBody }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    // `guard` has already refused a null principal; narrowing again rather than defaulting the
    // actor, because `actorUserId` names who did this and a placeholder would be a fabricated one.
    if (principal === null) return json(401, { error: "authentication_required" });
    const parsed = TransitionTenantBodySchema.safeParse(parsedBody ?? {});
    if (!parsed.success) {
      return json(400, {
        error: "invalid_request",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
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
    const action = CONSOLE_ACTION[target];
    // Non-null for every state the console can reach, which is a property of `CONSOLE_ACTION` and
    // `TENANT_STATUS_TRANSITIONS` together rather than of this call site — so a `null` here means
    // somebody mounted a route to a state the map declares unreachable, and the honest answer is to
    // leave the trail silent and say so rather than to invent an action for it.
    const lifecycleRecorded =
      action === null
        ? null
        : await recordConsoleTransition(ctx, {
            tenantId: id,
            action,
            fromState: current.status,
            reason: parsed.data.reason,
            actorUserId: principal.principalId,
          });
    return json(200, { tenant, lifecycleRecorded });
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
