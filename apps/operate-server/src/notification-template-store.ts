import type { PgConnection } from "@crossengin/kernel-pg";
import {
  TEMPLATE_STATUSES,
  canTransitionTemplate,
  type NotificationTemplate,
  type TemplateStatus,
} from "@crossengin/notifications";
import { withTenantContext } from "@crossengin/operate-runtime-pg";

import { templateFromRow } from "./template-store.js";

/**
 * The authoring half of `meta.notification_templates` (the ADR-0277 follow-up).
 *
 * `PostgresTemplateStore` resolves the template a *send* should use; it reads approved rows and
 * writes with a blanket `ON CONFLICT … DO UPDATE` that can set any status in one statement. That is
 * the right shape for a deployment seeding its own defaults and the wrong shape for authoring: an
 * author must not be able to write `status = 'approved'` directly, and a lifecycle move must not be
 * able to lose a concurrent one. So authoring is a separate store with a narrow surface — insert a
 * draft, read it back, and move it along the declared state machine one compare-and-set at a time.
 *
 * INVARIANT — writes are always `tenant_id = $1`, never `tenant_id IS NULL`. This store refuses a
 * platform-wide row before any SQL is issued, and that refusal is now the *second* layer rather than
 * the only one: the table used to carry one `ALL`-scope policy whose `USING` doubled as its
 * `WITH CHECK`, so `tenant_id IS NULL OR tenant_id = current_setting(…)` accepted a platform-wide
 * row from inside any tenant context and RLS genuinely could not defend it. It is three policies
 * now — tenant isolation, a `SELECT`-only platform read, and an `INSERT`-scoped platform write
 * gated on `app.platform_config_write` (plus an `UPDATE`-scoped one, because a template's status
 * moves) — so a platform row is refused by the database too. Nothing here claims that grant: no
 * route in this binary authors the platform-wide default, which an operator seeds as the owner.
 * The *read* side is unchanged, because the platform read policy demands no grant.
 */

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const NTPL_ID_RE = /^ntpl_[a-z0-9]{8,32}$/;

const UNIQUE_CONSTRAINT = "notification_templates_tenant_template_locale_version_key";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const SELECT_COLUMNS =
  "ntpl_id, tenant_id, template_id, version, locale, channel, category, status, content," +
  " variables, body_size_bytes, created_at, created_by, approved_at, approved_by," +
  " deprecated_at, superseded_by_template_id";

const INSERT_COLUMNS =
  "tenant_id, ntpl_id, template_id, version, locale, channel, category, status, content," +
  " variables, body_size_bytes, created_at, created_by";

export interface NotificationTemplateStoreOptions {
  readonly schema?: string;
}

export interface TemplateListQuery {
  readonly status?: TemplateStatus;
  readonly templateId?: string;
  readonly channel?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TemplateListPage {
  readonly data: readonly NotificationTemplate[];
  readonly nextCursor: string | null;
}

export interface TemplateTransitionRequest {
  readonly to: TemplateStatus;
  /** The authenticated actor. Never taken from a request body — four-eyes rests on this. */
  readonly actorId: string;
  readonly at: string;
}

/**
 * Why a transition did or did not happen, as a closed set rather than an exception.
 *
 * `four_eyes` is its own outcome, not a flavour of `illegal_transition`: the move is legal, the
 * actor is not, and a caller told "draft -> approved is not allowed" would reasonably retry it.
 */
export type TemplateTransitionOutcome =
  | { readonly kind: "transitioned"; readonly template: NotificationTemplate }
  | { readonly kind: "not_found" }
  | {
      readonly kind: "illegal_transition";
      readonly from: TemplateStatus;
      readonly to: TemplateStatus;
    }
  | { readonly kind: "four_eyes"; readonly authorId: string }
  /** The row moved between the read and the write; the caller re-reads rather than being lied to. */
  | { readonly kind: "conflict"; readonly from: TemplateStatus };

export interface TemplateCursor {
  readonly createdAt: string;
  readonly ntplId: string;
}

export function encodeTemplateCursor(cursor: TemplateCursor): string {
  return Buffer.from(`v1:${cursor.createdAt}:${cursor.ntplId}`, "utf8").toString("base64url");
}

/**
 * Null for anything this store did not issue. A cursor that silently rewinds to the first page
 * makes a caller re-read rows and believe the page after it does not exist, so a bad one is
 * refused rather than reinterpreted.
 */
export function decodeTemplateCursor(cursor: string | undefined): TemplateCursor | null {
  if (cursor === undefined || cursor.length === 0) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const match = /^v1:(.+):(ntpl_[a-z0-9]{8,32})$/.exec(decoded);
  if (match === null) return null;
  const createdAt = match[1] ?? "";
  const ntplId = match[2] ?? "";
  if (Number.isNaN(Date.parse(createdAt))) return null;
  return { createdAt, ntplId };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

/**
 * The columns a transition writes, besides `status`.
 *
 * Driven by the target status rather than by the route that asked for it, so the timestamps a
 * status requires are stamped wherever that status is reached — the contract refuses an approved
 * row with no `approvedBy`, and clearing the approval on the way back to `draft` is what keeps a
 * rejected template from carrying a stale signature.
 */
function transitionAssignments(
  to: TemplateStatus,
  nextParam: (value: unknown) => string,
  at: string,
): readonly string[] {
  switch (to) {
    case "approved":
      return [`approved_at = ${nextParam(at)}::timestamptz`, "approved_by = $5"];
    case "deprecated":
      return [`deprecated_at = ${nextParam(at)}::timestamptz`];
    case "draft":
      return ["approved_at = NULL", "approved_by = NULL"];
    case "in_review":
    case "retired":
      return [];
  }
}

export class PostgresNotificationTemplateStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: NotificationTemplateStoreOptions = {}) {
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

  /**
   * Inserts one draft. Null when the tenant already has that `(template_id, channel, locale,
   * version)` — a duplicate version is a 409 for the caller, not an overwrite: silently replacing
   * an approved body with a new one under the same version is how an approval gets bypassed.
   */
  async createDraft(
    tenantId: string,
    template: NotificationTemplate,
  ): Promise<NotificationTemplate | null> {
    if (!UUID_RE.test(tenantId)) {
      throw new Error(`invalid tenant id: ${JSON.stringify(tenantId)}`);
    }
    if (template.tenantId === null) {
      throw new Error("cannot author a platform-wide template: tenantId is null");
    }
    if (template.tenantId !== tenantId) {
      throw new Error(
        `template tenantId ${JSON.stringify(template.tenantId)} does not match caller tenant`,
      );
    }
    if (!NTPL_ID_RE.test(template.id)) {
      throw new Error(`invalid template id: ${JSON.stringify(template.id)}`);
    }
    // A draft is the only status this store will insert: every other status is reachable only by
    // a transition, which is where the state machine and four-eyes are enforced.
    if (template.status !== "draft") {
      throw new Error(`a created template must be a draft, not ${template.status}`);
    }
    if (template.approvedAt !== null || template.approvedBy !== null) {
      throw new Error("a created template cannot carry an approval");
    }
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `INSERT INTO ${this.table} (${INSERT_COLUMNS})` +
        " VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12::timestamptz, $13)" +
        ` ON CONFLICT ON CONSTRAINT ${UNIQUE_CONSTRAINT} DO NOTHING RETURNING ${SELECT_COLUMNS}`;
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
      ]);
      const row = result.rows[0];
      return row === undefined ? null : templateFromRow(row);
    });
  }

  /**
   * One of the tenant's own templates. A platform-wide row (`tenant_id IS NULL`) is deliberately
   * NOT visible here even though the read policy would allow it: this store exists to author and
   * transition, and a tenant must not be able to retire the operator's default.
   */
  async get(tenantId: string, ntplId: string): Promise<NotificationTemplate | null> {
    if (!NTPL_ID_RE.test(ntplId)) return null;
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query(
        `SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE tenant_id = $1 AND ntpl_id = $2`,
        [tenantId, ntplId],
      );
      const row = result.rows[0];
      return row === undefined ? null : templateFromRow(row);
    });
  }

  /**
   * The tenant's templates, newest first, keyset-paginated on `(created_at DESC, ntpl_id DESC)`.
   *
   * A row that no longer parses throws rather than being skipped (ADR-0289). Dropping it is how a
   * template edited into a state the contract forbids would become invisible, and an author
   * looking at a list that silently omits it has no way to notice.
   */
  async list(tenantId: string, query: TemplateListQuery = {}): Promise<TemplateListPage> {
    const limit = clampLimit(query.limit);
    const cursor = decodeTemplateCursor(query.cursor);
    if (query.cursor !== undefined && query.cursor.length > 0 && cursor === null) {
      throw new Error(`invalid template cursor: ${JSON.stringify(query.cursor)}`);
    }
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const params: unknown[] = [tenantId];
      const conditions: string[] = ["tenant_id = $1"];
      const bind = (value: unknown): string => {
        params.push(value);
        return `$${params.length.toString()}`;
      };
      if (query.status !== undefined) conditions.push(`status = ${bind(query.status)}`);
      if (query.templateId !== undefined) {
        conditions.push(`template_id = ${bind(query.templateId)}`);
      }
      if (query.channel !== undefined) conditions.push(`channel = ${bind(query.channel)}`);
      if (cursor !== null) {
        const at = bind(cursor.createdAt);
        const id = bind(cursor.ntplId);
        conditions.push(
          `(created_at < ${at}::timestamptz OR (created_at = ${at}::timestamptz AND ntpl_id < ${id}))`,
        );
      }
      const limitParam = bind(limit + 1);
      const sql =
        `SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE ${conditions.join(" AND ")}` +
        ` ORDER BY created_at DESC, ntpl_id DESC LIMIT ${limitParam}`;
      const result = await tx.query(sql, params);
      const rows = result.rows.map((r) => templateFromRow(r));
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      const last = data[data.length - 1];
      return {
        data,
        nextCursor:
          hasMore && last !== undefined
            ? encodeTemplateCursor({ createdAt: last.createdAt, ntplId: last.id })
            : null,
      };
    });
  }

  /**
   * Moves one template along `TEMPLATE_TRANSITIONS`.
   *
   * Three guards, deliberately not one. The declared state machine answers whether the move is
   * legal at all. Four-eyes is checked against the row's own `created_by`, so the rule holds for
   * whoever actually wrote it rather than for whoever the request says wrote it. And the UPDATE
   * carries `status = <from>` — and, for an approval, `created_by <> <actor>` — as a predicate, so
   * two approvals racing on one template cannot both win, and the check cannot be skipped by a row
   * that changed between the read and the write.
   */
  async transition(
    tenantId: string,
    ntplId: string,
    request: TemplateTransitionRequest,
  ): Promise<TemplateTransitionOutcome> {
    if (!TEMPLATE_STATUSES.includes(request.to)) {
      throw new Error(`unknown template status: ${JSON.stringify(request.to)}`);
    }
    if (!NTPL_ID_RE.test(ntplId)) return { kind: "not_found" };
    if (!UUID_RE.test(request.actorId)) {
      throw new Error(`invalid actor id: ${JSON.stringify(request.actorId)}`);
    }
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const current = await tx.query(
        `SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE tenant_id = $1 AND ntpl_id = $2`,
        [tenantId, ntplId],
      );
      const row = current.rows[0];
      if (row === undefined) return { kind: "not_found" };
      const template = templateFromRow(row);
      if (!canTransitionTemplate(template.status, request.to)) {
        return { kind: "illegal_transition", from: template.status, to: request.to };
      }
      if (request.to === "approved" && template.createdBy === request.actorId) {
        return { kind: "four_eyes", authorId: template.createdBy };
      }
      // $1..$5 are fixed so the statement reads the same for every target: tenant, template, the
      // status being set, the status it must still have, and the actor.
      const params: unknown[] = [tenantId, ntplId, request.to, template.status, request.actorId];
      const bind = (value: unknown): string => {
        params.push(value);
        return `$${params.length.toString()}`;
      };
      const assignments = [
        "status = $3",
        ...transitionAssignments(request.to, bind, request.at),
      ];
      const conditions = ["tenant_id = $1", "ntpl_id = $2", "status = $4"];
      if (request.to === "approved") conditions.push("created_by <> $5");
      const updated = await tx.query(
        `UPDATE ${this.table} SET ${assignments.join(", ")}` +
          ` WHERE ${conditions.join(" AND ")} RETURNING ${SELECT_COLUMNS}`,
        params,
      );
      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) return { kind: "conflict", from: template.status };
      // Re-parsed through `NotificationTemplateSchema`, so an approved row whose approver is its
      // own author cannot be returned even if some other writer managed to store one.
      return { kind: "transitioned", template: templateFromRow(updatedRow) };
    });
  }
}
