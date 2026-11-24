import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import { hmacSha256Hex } from "@crossengin/crypto";
import {
  isoInstant,
  readRows,
  requireIsoInstant,
  textIdentity,
  type PgConnection,
  type UnreadableRowReporter,
} from "@crossengin/kernel-pg";
import { STARTER_CHART_VERSION, type ExtraGatewayRoute, type StarterChartReport, type TenantSettings } from "@crossengin/operate-runtime";
import { setTenantContextWithin, type PostgresSettingsStore } from "@crossengin/operate-runtime-pg";
import { z } from "zod";

import { MAX_PASSWORD_LENGTH, passwordLength } from "./credential-routes.js";
import type { PostgresCredentialStore } from "./credential-store.js";
import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import { checkMembershipRoles } from "./membership-role-fence.js";
import { DuplicateTenantError, type PostgresTenantStore, type TenantCreationEvent } from "./platform-admin.js";
import { CreateTenantInputSchema, type TenantRecord } from "./platform-tenants.js";
import {
  DuplicateMembershipError,
  DuplicateUserError,
  ROLE_NAME_SCOPE_SAFE_MESSAGE,
  UnknownPrincipalError,
  normalizeEmail,
  refuseEscalation,
  type MembershipRecord,
  type PostgresUserStore,
  type UserRegistryAuditEvent,
} from "./platform-users.js";
import type { StarterChartProvisioner } from "./starter-chart-routes.js";
import { roleNameHasNoWhitespace } from "./token-mint.js";

/**
 * Public access requests and the operator's one-click approval (ADR-0464).
 *
 * A prospective customer fills a public form and **nothing is created**: the request is a row in
 * `meta.access_requests` and nothing more. A platform operator approves it, which creates the
 * tenant, its first user, the membership, the password and the default settings in **one**
 * transaction — so an approval either onboards a customer completely or leaves no trace, and there
 * is no half-provisioned workspace for anybody to find. There is no mail channel, so the operator
 * hands the password over out of band.
 *
 * The intake is unauthenticated by construction, which is what decides most of its shape: it
 * answers a re-submit exactly as it answers a new request, and it never looks up whether a user or a
 * slug exists, because each of those would make it an oracle for who is already a customer.
 */

/* ------------------------------------------------------------------ contracts */

/** `meta.access_requests.status`' CHECK, which is the whole of this vocabulary. */
export const ACCESS_REQUEST_STATUSES = ["pending", "approved", "rejected"] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

export const ACCESS_REQUEST_INTAKE_PATH = "/v1/public/access-requests";
export const ACCESS_REQUEST_TERMS_PATH = "/v1/public/access-requests/terms";

/**
 * Slugs no approval may take, because each names a host, a route or a role an operator or a
 * customer would read as the platform's own rather than one tenant's.
 */
export const RESERVED_TENANT_SLUGS = [
  "admin",
  "api",
  "www",
  "app",
  "platform",
  "login",
  "logout",
  "auth",
  "help",
  "support",
  "status",
  "root",
  "system",
  "mail",
  "static",
  "assets",
  "docs",
  "billing",
  "security",
  "crossengin",
  "public",
] as const;

const RESERVED_SLUG_SET: ReadonlySet<string> = new Set(RESERVED_TENANT_SLUGS);

/** The catalog's `requested_slug` CHECK, which is also `platform-tenants.ts`' slug rule. */
const SLUG_RE = /^[a-z][a-z0-9-]{1,48}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export const ACCESS_REQUEST_APPROVED_OPERATION = "platform.access_request_approved";
export const ACCESS_REQUEST_REJECTED_OPERATION = "platform.access_request_rejected";
export const ACCESS_REQUESTS_BULK_REJECTED_OPERATION = "platform.access_requests_rejected";
/** The second row when an approval that was recorded then did not land (ADR-0313's pairing). */
export const ACCESS_REQUEST_REFUSED_OPERATION = "platform.access_request_refused";

export const AccessRequestRecordSchema = z
  .object({
    id: z.string().uuid(),
    companyName: z.string().min(1).max(200),
    requestedSlug: z.string().regex(SLUG_RE).nullable(),
    contactName: z.string().min(1).max(200),
    email: z.string().min(3).max(254),
    message: z.string().max(2000).nullable(),
    termsVersion: z.string().min(1).max(64),
    termsAcceptedAt: z.string().datetime({ offset: true }),
    status: z.enum(ACCESS_REQUEST_STATUSES),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    decidedAt: z.string().datetime({ offset: true }).nullable(),
    decidedBy: z.string().uuid().nullable(),
    decisionReason: z.string().min(1).max(500).nullable(),
    approvedTenantId: z.string().uuid().nullable(),
    approvedUserId: z.string().uuid().nullable(),
  })
  .strict()
  // The catalog's `access_requests_decision_pairing_check`, restated so a row edited past it by hand
  // is refused on read rather than served (ADR-0289).
  .superRefine((r, ctx) => {
    const decided = r.decidedAt !== null && r.decidedBy !== null;
    const approvedRefs = r.approvedTenantId !== null && r.approvedUserId !== null;
    const noApprovedRefs = r.approvedTenantId === null && r.approvedUserId === null;
    const ok =
      r.status === "pending"
        ? r.decidedAt === null && r.decidedBy === null && r.decisionReason === null && noApprovedRefs
        : r.status === "approved"
          ? decided && approvedRefs
          : decided && noApprovedRefs;
    if (!ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `decision fields disagree with status '${r.status}'`,
        path: ["status"],
      });
    }
  });
export type AccessRequestRecord = z.infer<typeof AccessRequestRecordSchema>;

/* --------------------------------------------------------------------- store */

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACCESS_REQUEST_COLUMNS =
  "id, company_name, requested_slug, contact_name, email, message, terms_version," +
  " terms_accepted_at, status, created_at, expires_at, decided_at, decided_by, decision_reason," +
  " approved_tenant_id, approved_user_id";

interface AccessRequestRow {
  readonly id: unknown;
  readonly company_name: unknown;
  readonly requested_slug: unknown;
  readonly contact_name: unknown;
  readonly email: unknown;
  readonly message: unknown;
  readonly terms_version: unknown;
  readonly terms_accepted_at: unknown;
  readonly status: unknown;
  readonly created_at: unknown;
  readonly expires_at: unknown;
  readonly decided_at: unknown;
  readonly decided_by: unknown;
  readonly decision_reason: unknown;
  readonly approved_tenant_id: unknown;
  readonly approved_user_id: unknown;
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // Every column read through here is TEXT or UUID, which node-postgres hands back as a string;
  // anything else is rendered so the contract refuses it rather than reading `[object Object]`.
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function accessRequestFromRow(row: AccessRequestRow): AccessRequestRecord {
  return AccessRequestRecordSchema.parse({
    id: String(row.id),
    companyName: String(row.company_name),
    requestedSlug: textOrNull(row.requested_slug),
    contactName: String(row.contact_name),
    email: String(row.email),
    message: textOrNull(row.message),
    termsVersion: String(row.terms_version),
    termsAcceptedAt: requireIsoInstant(row.terms_accepted_at, "access_requests.terms_accepted_at"),
    status: String(row.status),
    createdAt: requireIsoInstant(row.created_at, "access_requests.created_at"),
    expiresAt: requireIsoInstant(row.expires_at, "access_requests.expires_at"),
    decidedAt: isoInstant(row.decided_at),
    decidedBy: textOrNull(row.decided_by),
    decisionReason: textOrNull(row.decision_reason),
    approvedTenantId: textOrNull(row.approved_tenant_id),
    approvedUserId: textOrNull(row.approved_user_id),
  });
}

export interface AccessRequestSubmission {
  readonly companyName: string;
  readonly requestedSlug: string | null;
  readonly contactName: string;
  /** Normalized by the store; the catalog refuses a mixed-case address. */
  readonly email: string;
  readonly message: string | null;
  readonly termsVersion: string;
  readonly termsAcceptedAt: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface AccessRequestApproval {
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly approvedTenantId: string;
  readonly approvedUserId: string;
}

export interface AccessRequestRejection {
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly decisionReason: string;
}

export interface AccessRequestListQuery {
  readonly status?: AccessRequestStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface AccessRequestListPage {
  readonly data: readonly AccessRequestRecord[];
  readonly nextCursor: string | null;
}

export type AccessRequestCounts = Readonly<Record<AccessRequestStatus, number>> & {
  readonly total: number;
};

export const ACCESS_REQUEST_LIST_DEFAULT_LIMIT = 50;
export const ACCESS_REQUEST_LIST_MAX_LIMIT = 200;

/** A cursor this module did not mint, or minted over a row shape it no longer reads. */
export class AccessRequestCursorInvalid extends Error {
  constructor() {
    super("access request list cursor is not one this server issued");
    this.name = "AccessRequestCursorInvalid";
  }
}

function decodeListCursor(cursor: string): { readonly createdAt: string; readonly id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new AccessRequestCursorInvalid();
  }
  const shape = z
    .object({ c: z.string().datetime({ offset: true }), i: z.string().regex(UUID_RE) })
    .strict()
    .safeParse(parsed);
  if (!shape.success) throw new AccessRequestCursorInvalid();
  return { createdAt: shape.data.c, id: shape.data.i };
}

export interface PostgresAccessRequestStoreOptions {
  readonly schema?: string;
}

/**
 * `meta.access_requests`. Platform-wide — no `tenant_id`, no RLS — so no statement here sets a
 * tenant context or carries a scope predicate, and must not: naming a column the table does not have
 * is ADR-0332's `default_value` defect.
 *
 * Every timestamp is written from the caller's clock rather than `now()`, at millisecond precision,
 * so the keyset cursor (which carries `created_at` as a JS instant) addresses the row it came from
 * exactly — a microsecond `now()` default would re-admit or skip rows at page boundaries.
 */
export class PostgresAccessRequestStore {
  private readonly table: string;

  constructor(
    private readonly conn: PgConnection,
    options: PostgresAccessRequestStoreOptions = {},
  ) {
    const schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.table = `${schema}.access_requests`;
  }

  /**
   * Inserts a pending request, or absorbs it when the address already has one.
   *
   * An expired pending row for the address is removed first, in the same transaction: the sweep
   * runs hourly, and until it did the unique index would absorb every re-submit into a request that
   * can no longer be approved — a customer whose first request lapsed could not ask again.
   */
  async submit(
    input: AccessRequestSubmission,
  ): Promise<{ readonly inserted: boolean; readonly id: string | null }> {
    const email = normalizeEmail(input.email);
    return this.conn.transaction(async (tx) => {
      await tx.query(
        `DELETE FROM ${this.table}` +
          " WHERE email = $1 AND status = 'pending' AND expires_at <= $2::timestamptz",
        [email, input.createdAt],
      );
      const result = await tx.query<{ id: unknown }>(
        `INSERT INTO ${this.table}` +
          " (company_name, requested_slug, contact_name, email, message, terms_version," +
          " terms_accepted_at, created_at, expires_at)" +
          " VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz)" +
          " ON CONFLICT (email) WHERE status = 'pending' DO NOTHING RETURNING id",
        [
          input.companyName,
          input.requestedSlug,
          input.contactName,
          email,
          input.message,
          input.termsVersion,
          input.termsAcceptedAt,
          input.createdAt,
          input.expiresAt,
        ],
      );
      const row = result.rows[0];
      return row === undefined ? { inserted: false, id: null } : { inserted: true, id: String(row.id) };
    });
  }

  async countPending(): Promise<number> {
    const result = await this.conn.query<{ count: unknown }>(
      `SELECT count(*)::int AS count FROM ${this.table} WHERE status = 'pending'`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /** One row; a row the contract refuses throws, because the caller asked about that row. */
  async get(id: string): Promise<AccessRequestRecord | null> {
    if (!UUID_RE.test(id)) return null;
    const result = await this.conn.query<AccessRequestRow>(
      `SELECT ${ACCESS_REQUEST_COLUMNS} FROM ${this.table} WHERE id = $1::uuid`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : accessRequestFromRow(row);
  }

  /**
   * Newest first, keyset on `(created_at, id)`. A row the contract refuses is reported and left
   * out of the page, because the console's queue must still show every other request.
   */
  async list(
    query: AccessRequestListQuery,
    onUnreadable: UnreadableRowReporter,
  ): Promise<AccessRequestListPage> {
    const limit = Math.min(
      Math.max(1, Math.trunc(query.limit ?? ACCESS_REQUEST_LIST_DEFAULT_LIMIT)),
      ACCESS_REQUEST_LIST_MAX_LIMIT,
    );
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (query.status !== undefined) {
      params.push(query.status);
      clauses.push(`status = $${String(params.length)}`);
    }
    if (query.cursor !== undefined) {
      const after = decodeListCursor(query.cursor);
      params.push(after.createdAt);
      const at = params.length;
      params.push(after.id);
      clauses.push(`(created_at, id) < ($${String(at)}::timestamptz, $${String(at + 1)}::uuid)`);
    }
    params.push(limit + 1);
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const result = await this.conn.query<AccessRequestRow>(
      `SELECT ${ACCESS_REQUEST_COLUMNS} FROM ${this.table}${where}` +
        ` ORDER BY created_at DESC, id DESC LIMIT $${String(params.length)}`,
      params,
    );
    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const records = readRows(
      rows,
      accessRequestFromRow,
      (row) => textIdentity(row, "id"),
      onUnreadable,
    );
    // The cursor comes from the last row READ, not the last row kept: an unreadable last row must
    // still advance the walk past itself, or the next page would answer it again.
    const last = rows[rows.length - 1];
    let nextCursor: string | null = null;
    if (hasMore && last !== undefined) {
      nextCursor = Buffer.from(
        JSON.stringify({
          c: requireIsoInstant(last.created_at, "access_requests.created_at"),
          i: String(last.id),
        }),
        "utf8",
      ).toString("base64url");
    }
    return { data: records, nextCursor };
  }

  async counts(): Promise<AccessRequestCounts> {
    const result = await this.conn.query<{ status: unknown; count: unknown }>(
      `SELECT status, count(*)::int AS count FROM ${this.table} GROUP BY status`,
    );
    const counts: Record<AccessRequestStatus, number> = { pending: 0, approved: 0, rejected: 0 };
    let total = 0;
    for (const row of result.rows) {
      const status = String(row.status);
      const n = Number(row.count);
      if ((ACCESS_REQUEST_STATUSES as readonly string[]).includes(status)) {
        counts[status as AccessRequestStatus] += n;
      }
      total += n;
    }
    return { ...counts, total };
  }

  /**
   * Marks a request approved inside the approval's own transaction. The guard is the row itself
   * (ADR-0321): a concurrent decision, or an expiry, wins it and this answers `false`, which the
   * caller turns into a rollback of the whole onboarding.
   */
  async markApprovedWithin(
    tx: PgConnection,
    id: string,
    decision: AccessRequestApproval,
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE ${this.table} SET status = 'approved', decided_at = $2::timestamptz,` +
        " decided_by = $3, approved_tenant_id = $4::uuid, approved_user_id = $5::uuid" +
        " WHERE id = $1::uuid AND status = 'pending' AND expires_at > now()",
      [
        id,
        decision.decidedAt,
        decision.decidedBy,
        decision.approvedTenantId,
        decision.approvedUserId,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Rejects one pending request. Expiry does not matter: a lapsed request may still be refused. */
  async reject(id: string, decision: AccessRequestRejection): Promise<boolean> {
    const result = await this.conn.query(
      `UPDATE ${this.table} SET status = 'rejected', decided_at = $2::timestamptz,` +
        " decided_by = $3, decision_reason = $4" +
        " WHERE id = $1::uuid AND status = 'pending'",
      [id, decision.decidedAt, decision.decidedBy, decision.decisionReason],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async rejectAllPending(decision: AccessRequestRejection): Promise<number> {
    const result = await this.conn.query(
      `UPDATE ${this.table} SET status = 'rejected', decided_at = $1::timestamptz,` +
        " decided_by = $2, decision_reason = $3 WHERE status = 'pending'",
      [decision.decidedAt, decision.decidedBy, decision.decisionReason],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Deletes pending requests past their expiry and decided ones older than the retention window.
   *
   * The row is operational and not evidence: the terms a customer accepted are recorded permanently
   * in the approval's `meta.audit_log` row, so nothing here outlives its purpose.
   */
  async sweep(input: {
    readonly now: Date;
    readonly retentionDays: number;
  }): Promise<{ readonly expiredDeleted: number; readonly decidedDeleted: number }> {
    const now = input.now.toISOString();
    const cutoff = new Date(input.now.getTime() - input.retentionDays * 86_400_000).toISOString();
    const expired = await this.conn.query(
      `DELETE FROM ${this.table} WHERE status = 'pending' AND expires_at <= $1::timestamptz`,
      [now],
    );
    const decided = await this.conn.query(
      `DELETE FROM ${this.table} WHERE status <> 'pending' AND decided_at < $1::timestamptz`,
      [cutoff],
    );
    return { expiredDeleted: expired.rowCount ?? 0, decidedDeleted: decided.rowCount ?? 0 };
  }
}

/* -------------------------------------------------------------- public intake */

/** What the intake publishes about the terms a request accepts. Absent when the intake is closed. */
export interface AccessRequestTerms {
  readonly termsVersion: string;
  readonly termsUrl: string;
  readonly privacyUrl: string;
}

export const ACCESS_REQUEST_MAX_BODY_BYTES = 8 * 1024;
/** The process-wide ceiling, beside the per-client bound the login's limiter applies. */
export const ACCESS_REQUEST_SUBMISSIONS_PER_MINUTE = 30;
const QUEUE_FULL_RETRY_AFTER_SECONDS = 3600;

/** A fixed one-minute window over every submission this process receives. */
export class SubmissionWindow {
  private windowStart = 0;
  private count = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** `null` when admitted, else the seconds until the window rolls. */
  admit(nowMs: number): number | null {
    if (nowMs - this.windowStart >= this.windowMs) {
      this.windowStart = nowMs;
      this.count = 0;
    }
    if (this.count >= this.limit) {
      return Math.max(1, Math.ceil((this.windowStart + this.windowMs - nowMs) / 1000));
    }
    this.count += 1;
    return null;
  }
}

const emptyToUndefined = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const IntakeBodySchema = z
  .object({
    companyName: z.string().trim().min(1).max(200),
    contactName: z.string().trim().min(1).max(200),
    email: z.string().trim().max(254).email(),
    requestedSlug: z.preprocess(emptyToUndefined, z.string().trim().regex(SLUG_RE).optional()),
    message: z.preprocess(emptyToUndefined, z.string().max(2000).optional()),
    termsVersion: z.string().min(1).max(64),
    termsAccepted: z.literal(true),
    // The honeypot. A name no browser autofills (`website` is one some do), so a human never fills
    // it and a form-filling bot that fills every field does.
    ce_hp_extra: z.string().max(500).optional(),
  })
  .strict();

export interface AccessRequestIntakeContext {
  readonly store: Pick<PostgresAccessRequestStore, "submit" | "countPending">;
  /** `null` is a closed intake: some deployment has not published its terms. */
  readonly terms: AccessRequestTerms | null;
  readonly maxPending: number;
  readonly ttlHours: number;
  /**
   * How long a decided request is kept. Published on the terms answer beside `ttlHours`, so the
   * public privacy notice states this deployment's real figures rather than the defaults.
   */
  readonly retentionDays: number;
  readonly window: SubmissionWindow;
  readonly clock?: () => Date;
  /** Called with the new id and the pending count after it; never with the company or the email. */
  readonly onSubmitted?: (id: string, pendingNow: number) => void;
  readonly onError?: (err: unknown) => void;
}

function intakeJson(
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): RawHttpResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

/** One body for a new request and an absorbed re-submit, so the route is not an address oracle. */
const RECEIVED = { status: "received" } as const;

function pathOf(url: string): string {
  return url.split("?")[0] ?? "";
}

export function isAccessRequestIntakePath(url: string): boolean {
  return pathOf(url) === ACCESS_REQUEST_INTAKE_PATH;
}

/**
 * The two public paths, in front of the gateway for the login's reason: `authenticate` runs before
 * `match_route`, so a gateway route is behind a credential and a prospective customer has none.
 * Answers `null` for any other path, so the caller falls through.
 */
export function buildAccessRequestIntake(
  ctx: AccessRequestIntakeContext,
): (raw: RawHttpRequest, body: Uint8Array | null) => Promise<RawHttpResponse | null> {
  const clock = ctx.clock ?? ((): Date => new Date());
  return async (raw, body) => {
    const path = pathOf(raw.url);
    const method = raw.method.toUpperCase();
    if (path === ACCESS_REQUEST_TERMS_PATH) {
      if (method !== "GET") {
        return intakeJson(405, { error: "method_not_allowed" }, { allow: "GET" });
      }
      return intakeJson(
        200,
        ctx.terms === null
          ? {
              open: false,
              termsVersion: null,
              termsUrl: null,
              privacyUrl: null,
              ttlHours: ctx.ttlHours,
              retentionDays: ctx.retentionDays,
            }
          : {
              open: true,
              termsVersion: ctx.terms.termsVersion,
              termsUrl: ctx.terms.termsUrl,
              privacyUrl: ctx.terms.privacyUrl,
              ttlHours: ctx.ttlHours,
              retentionDays: ctx.retentionDays,
            },
      );
    }
    if (path !== ACCESS_REQUEST_INTAKE_PATH) return null;
    if (method !== "POST") {
      return intakeJson(405, { error: "method_not_allowed" }, { allow: "POST" });
    }
    // 1. Closed before anything else, so a closed deployment does no work for an anonymous caller.
    const terms = ctx.terms;
    if (terms === null) return intakeJson(503, { error: "intake_closed" });

    const now = clock();
    const retryAfter = ctx.window.admit(now.getTime());
    if (retryAfter !== null) {
      return intakeJson(429, { error: "too_many_requests" }, { "retry-after": retryAfter.toString() });
    }

    // 2. Field paths and nothing else from the parse: an anonymous caller is told which field to
    // fix and never the validator's wording, which can quote what was sent.
    if (body !== null && body.byteLength > ACCESS_REQUEST_MAX_BODY_BYTES) {
      return intakeJson(400, { error: "invalid_request" });
    }
    let raw_body: unknown;
    try {
      const text = body === null ? "" : new TextDecoder().decode(body);
      raw_body = JSON.parse(text === "" ? "{}" : text);
    } catch {
      return intakeJson(400, { error: "invalid_request" });
    }
    const parsed = IntakeBodySchema.safeParse(raw_body);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".")).filter((p) => p !== ""))];
      return intakeJson(400, { error: "invalid_request", fields });
    }
    const req = parsed.data;

    // 3. A filled honeypot is a bot: answered as a success so it learns nothing, and stored nowhere.
    if (req.ce_hp_extra !== undefined && req.ce_hp_extra.trim() !== "") return intakeJson(202, RECEIVED);

    // 4. The page that showed the terms is stale; the client reloads and the customer re-accepts.
    if (req.termsVersion !== terms.termsVersion) return intakeJson(409, { error: "terms_changed" });

    // 5. Reserved slugs are a published list, so naming one discloses nothing.
    if (req.requestedSlug !== undefined && RESERVED_SLUG_SET.has(req.requestedSlug)) {
      return intakeJson(400, { error: "slug_reserved" });
    }

    try {
      // 6. The queue's ceiling, so an unattended deployment cannot be filled without bound.
      const pending = await ctx.store.countPending();
      if (pending >= ctx.maxPending) {
        return intakeJson(
          503,
          { error: "queue_full" },
          { "retry-after": QUEUE_FULL_RETRY_AFTER_SECONDS.toString() },
        );
      }
      // 7. No user or slug lookup here: either would make the intake an oracle for who is already
      // a customer. A slug that is taken is the approver's problem, at approval.
      const at = now.toISOString();
      const result = await ctx.store.submit({
        companyName: req.companyName,
        requestedSlug: req.requestedSlug ?? null,
        contactName: req.contactName,
        email: normalizeEmail(req.email),
        message: req.message ?? null,
        termsVersion: req.termsVersion,
        termsAcceptedAt: at,
        createdAt: at,
        expiresAt: new Date(now.getTime() + ctx.ttlHours * 3_600_000).toISOString(),
      });
      if (result.inserted && result.id !== null) ctx.onSubmitted?.(result.id, pending + 1);
      return intakeJson(202, RECEIVED);
    } catch (err) {
      ctx.onError?.(err);
      return intakeJson(503, { error: "intake_unavailable" });
    }
  };
}

/* ----------------------------------------------------------- platform routes */

export interface AccessRequestAuditEvent {
  readonly operation: string;
  /** Null for the bulk rejection, which is about no one request. */
  readonly requestId: string | null;
  readonly principalId: string | null;
  readonly roles: readonly string[];
  /** Never carries a password, a hash or a pepper. */
  readonly detail: Readonly<Record<string, unknown>>;
  readonly at: string;
}

export type AccessRequestAuditor = (event: AccessRequestAuditEvent) => Promise<void>;

/** The access-request origin a tenant's creation record carries as permanent terms evidence. */
export type AccessRequestOrigin = NonNullable<TenantCreationEvent["origin"]>;

export interface AccessRequestRoutesContext {
  readonly store: Pick<
    PostgresAccessRequestStore,
    "get" | "list" | "counts" | "markApprovedWithin" | "reject" | "rejectAllPending"
  >;
  readonly tenants: Pick<PostgresTenantStore, "create">;
  readonly users: Pick<PostgresUserStore, "getByEmail" | "provisionWithin" | "grantMembershipWithin">;
  readonly credentials: Pick<PostgresCredentialStore, "setCredentialWithin">;
  readonly settings: Pick<PostgresSettingsStore, "putWithin">;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Read, reject and list. Fail-closed: empty ⇒ nobody. */
  readonly platformAdminRoles: ReadonlySet<string>;
  /** Approving also provisions a user and grants a membership. */
  readonly platformUserRoles: ReadonlySet<string>;
  /** Approving also sets a password. */
  readonly credentialAdminRoles: ReadonlySet<string>;
  readonly platformAuthorityRoles: ReadonlySet<string>;
  /**
   * The roles a workspace created now would be served — the deployment's own manifest, since the
   * tenant has no activated manifest of its own yet. `null` when this process cannot name the set.
   */
  readonly newTenantRoles: ReadonlySet<string> | null;
  readonly defaultPrimaryRole: string;
  readonly minPasswordLength: number;
  /**
   * `hashPassword` under the deployment's pepper, admitted through the login's shared admission so
   * an approval's scrypt cannot crowd out sign-ins on the one libuv pool. `null` is shed: no
   * capacity right now, nothing recorded and nothing written.
   */
  readonly hashPassword: (password: string, accountKey: string) => Promise<string | null>;
  /**
   * The key the contact address is HMAC'd under in the creation record, derived from the credential
   * pepper (`deriveAccessRequestContactKey`), with the pepper version it came from so a later reader
   * knows which pepper the digest needs.
   */
  readonly contactEmailKey: ContactEmailKey;
  readonly audit: AccessRequestAuditor;
  /** The tenant-creation record `--platform-admin` writes, inside the creating transaction. */
  readonly recordCreation: (tx: PgConnection, event: TenantCreationEvent) => Promise<void>;
  readonly onUnreadable: UnreadableRowReporter;
  readonly onApproved?: (requestId: string, slug: string) => void;
  /**
   * Creates the starter chart of accounts for a just-approved workspace and fills its unset finance
   * account codes (ADR-0465). **Required**, so a deployment cannot mount approvals that silently
   * skip the chart; it is called after the approval commits and may throw, which is reported on the
   * 201 as `failed` rather than undoing an approval that already happened.
   */
  readonly provisionStarterChart: StarterChartProvisioner;
  /**
   * The roles the chart's accounts are written as (`--job-actor-role`), recorded in the approval's
   * audit detail when a chart is requested, so the trail says under whose authority they were
   * written and not only who approved.
   */
  readonly starterChartActingRoles: readonly string[];
  readonly clock?: () => Date;
}

function json(status: number, body: unknown, headers?: Record<string, string>): HandlerOutput {
  return headers === undefined ? { kind: "json", status, body } : { kind: "json", status, headers, body };
}

function rolesOf(ctx: AccessRequestRoutesContext, principal: ResolvedPrincipal | null): string[] {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])];
}

function holdsAny(roles: readonly string[], grant: ReadonlySet<string>): boolean {
  return roles.some((r) => grant.has(r));
}

function adminGuard(
  ctx: AccessRequestRoutesContext,
  principal: ResolvedPrincipal | null,
): HandlerOutput | null {
  if (principal === null) return json(401, { error: "authentication_required" });
  if (!holdsAny(rolesOf(ctx, principal), ctx.platformAdminRoles)) {
    return json(403, { error: "forbidden", detail: "insufficient role" });
  }
  return null;
}

/**
 * The catalog's `uuidShapeCheck` on `decided_by`, as a regex: lowercase only, which is narrower than
 * `z.string().uuid()`. A principal whose id fails it would be recorded as approving or rejecting and
 * then refused by the decision row's CHECK — an audit row about a decision that never landed.
 */
const DECIDED_BY_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function unrecordablePrincipal(principal: ResolvedPrincipal): HandlerOutput | null {
  if (DECIDED_BY_SHAPE.test(principal.principalId)) return null;
  return json(403, {
    error: "principal_not_recordable",
    detail: "a decision is recorded against the deciding principal's id, and this credential's id is not a uuid",
  });
}

function nowIso(ctx: AccessRequestRoutesContext): string {
  return (ctx.clock ?? ((): Date => new Date()))().toISOString();
}

async function record(
  ctx: AccessRequestRoutesContext,
  event: Omit<AccessRequestAuditEvent, "at">,
): Promise<HandlerOutput | null> {
  try {
    await ctx.audit({ ...event, at: nowIso(ctx) });
    return null;
  } catch {
    return json(503, {
      error: "audit_unavailable",
      detail: "an access-request decision cannot be made while it cannot be recorded",
    });
  }
}

/** Best effort, as `recordRefusal` in `platform-users.ts`: nothing changed, so no 503. */
async function recordRefusal(
  ctx: AccessRequestRoutesContext,
  attempted: Omit<AccessRequestAuditEvent, "at">,
  refusal: string,
  output: HandlerOutput,
): Promise<HandlerOutput> {
  try {
    await ctx.audit({
      ...attempted,
      operation: ACCESS_REQUEST_REFUSED_OPERATION,
      detail: { ...attempted.detail, attempted: attempted.operation, refusal },
      at: nowIso(ctx),
    });
  } catch {
    /* nothing was changed */
  }
  return output;
}

function firstQueryValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const first = typeof value === "string" ? value : value[0];
  return first === undefined || first.length === 0 ? undefined : first;
}

function buildListHandler(ctx: AccessRequestRoutesContext): Handler {
  return async (input) => {
    const denial = adminGuard(ctx, input.principal);
    if (denial !== null) return denial;
    const query = input.request.query ?? {};
    const statusRaw = firstQueryValue(query["status"]);
    if (statusRaw !== undefined && !(ACCESS_REQUEST_STATUSES as readonly string[]).includes(statusRaw)) {
      return json(400, { error: "invalid_query", detail: `unknown status '${statusRaw}'` });
    }
    const limitRaw = firstQueryValue(query["limit"]);
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      if (!/^\d{1,4}$/.test(limitRaw) || Number(limitRaw) < 1) {
        return json(400, { error: "invalid_query", detail: "limit must be a positive integer" });
      }
      limit = Number(limitRaw);
    }
    const cursor = firstQueryValue(query["cursor"]);
    let page: AccessRequestListPage;
    try {
      page = await ctx.store.list(
        {
          ...(statusRaw !== undefined ? { status: statusRaw as AccessRequestStatus } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        },
        ctx.onUnreadable,
      );
    } catch (err) {
      if (err instanceof AccessRequestCursorInvalid) {
        return json(400, { error: "invalid_query", detail: "cursor is not one this server issued" });
      }
      throw err;
    }
    return json(200, { data: page.data, page: { nextCursor: page.nextCursor } });
  };
}

function buildStatsHandler(ctx: AccessRequestRoutesContext): Handler {
  return async ({ principal }) => {
    const denial = adminGuard(ctx, principal);
    if (denial !== null) return denial;
    return json(200, await ctx.store.counts());
  };
}

const ReasonBodySchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

function buildRejectHandler(ctx: AccessRequestRoutesContext): Handler {
  return async ({ principal, params, parsedBody }) => {
    const denial = adminGuard(ctx, principal);
    if (denial !== null || principal === null) return denial ?? json(401, { error: "authentication_required" });
    const unshaped = unrecordablePrincipal(principal);
    if (unshaped !== null) return unshaped;
    const body = ReasonBodySchema.safeParse(parsedBody ?? {});
    if (!body.success) {
      return json(400, { error: "invalid_request", detail: "reason is required (1..500 characters)" });
    }
    const id = params["id"] ?? "";
    const request = await ctx.store.get(id);
    if (request === null) return json(404, { error: "access_request_not_found" });
    if (request.status !== "pending") return json(409, { error: "not_pending", status: request.status });
    const event: Omit<AccessRequestAuditEvent, "at"> = {
      operation: ACCESS_REQUEST_REJECTED_OPERATION,
      requestId: id,
      principalId: principal.principalId,
      roles: rolesOf(ctx, principal),
      detail: { reason: body.data.reason },
    };
    const unrecordable = await record(ctx, event);
    if (unrecordable !== null) return unrecordable;
    const landed = await ctx.store.reject(id, {
      decidedBy: principal.principalId,
      decidedAt: nowIso(ctx),
      decisionReason: body.data.reason,
    });
    if (!landed) {
      return recordRefusal(ctx, event, "not_pending", json(409, { error: "not_pending" }));
    }
    return json(200, { id, status: "rejected" });
  };
}

function buildRejectPendingHandler(ctx: AccessRequestRoutesContext): Handler {
  return async ({ principal, parsedBody }) => {
    const denial = adminGuard(ctx, principal);
    if (denial !== null || principal === null) return denial ?? json(401, { error: "authentication_required" });
    const unshaped = unrecordablePrincipal(principal);
    if (unshaped !== null) return unshaped;
    const body = ReasonBodySchema.safeParse(parsedBody ?? {});
    if (!body.success) {
      return json(400, { error: "invalid_request", detail: "reason is required (1..500 characters)" });
    }
    const unrecordable = await record(ctx, {
      operation: ACCESS_REQUESTS_BULK_REJECTED_OPERATION,
      requestId: null,
      principalId: principal.principalId,
      roles: rolesOf(ctx, principal),
      detail: { reason: body.data.reason },
    });
    if (unrecordable !== null) return unrecordable;
    const rejected = await ctx.store.rejectAllPending({
      decidedBy: principal.principalId,
      decidedAt: nowIso(ctx),
      decisionReason: body.data.reason,
    });
    return json(200, { rejected });
  };
}

const ApproveBodySchema = z
  .object({
    slug: z.string().regex(SLUG_RE).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().max(254).email().optional(),
    primaryRole: z
      .string()
      .min(1)
      .max(100)
      .refine(roleNameHasNoWhitespace, { message: ROLE_NAME_SCOPE_SAFE_MESSAGE })
      .optional(),
    // Length is checked after the parse so the refusal can be its own code; the ceiling here only
    // stops an absurd body before anything reads it.
    password: z.string().max(MAX_PASSWORD_LENGTH * 4).optional(),
    defaultCurrency: z.string().optional(),
    paymentTermsDays: z.number().int().min(0).max(365).optional(),
    attachExistingUser: z.boolean().optional(),
    confirmedExistingOwner: z.boolean().optional(),
    /**
     * Whether to create the starter chart of accounts after the workspace commits (ADR-0465).
     * Absent means yes: without it the workspace's first invoice is refused until an admin builds a
     * chart by hand, so the default is the one a new customer can use. `false` is for a company
     * bringing its own chart.
     */
    starterChart: z.boolean().optional(),
  })
  .strict();

/** The decision row did not land: a concurrent decision or the expiry won it. Rolls back. */
class ApprovalLost extends Error {
  constructor() {
    super("the access request was decided or expired while it was being approved");
    this.name = "ApprovalLost";
  }
}

/** The creation record could not be written, so nothing is created (ADR-0313). */
class ApprovalUnrecordable extends Error {
  constructor(readonly underlying: unknown) {
    super("tenant creation could not be recorded");
    this.name = "ApprovalUnrecordable";
  }
}

/** The derived key a contact address is digested under, and the pepper version it came from. */
export interface ContactEmailKey {
  readonly key: Uint8Array;
  readonly pepperVersion: number;
}

/**
 * HMAC-SHA256 hex of the lowercased address under a deployment-held key. Keyed and never a bare
 * digest: the audit log outlives an Article 17 erasure, and an unkeyed hash of an email is
 * confirmable by anyone holding the log and a candidate address.
 */
export function contactEmailHmacSha256(key: Uint8Array, email: string): string {
  return hmacSha256Hex(key, normalizeEmail(email));
}

/** What the 201 says about the chart: the report, or why there is none. */
export type StarterChartAnswer =
  | StarterChartReport
  | { readonly outcome: "not_requested" }
  | { readonly outcome: "failed"; readonly error: string };

async function provisionChart(
  ctx: AccessRequestRoutesContext,
  tenantId: string,
  requestId: string,
  principalId: string,
): Promise<StarterChartAnswer> {
  try {
    return await ctx.provisionStarterChart(tenantId, { provisioningId: requestId, principalId, newWorkspace: true });
  } catch (err) {
    // The error's name and never its message: a driver message can quote a value.
    const error = err instanceof Error ? err.name : "unknown";
    console.error(`[access-request] starter chart for request ${requestId} failed: ${error}`);
    return { outcome: "failed", error };
  }
}

const APPROVE_FORBIDDEN_DETAIL =
  "approving needs the platform-admin, platform-user and credential-admin grants";

function buildApproveHandler(ctx: AccessRequestRoutesContext): Handler {
  return async ({ principal, params, parsedBody }) => {
    // 1. All three grants: an approval creates a tenant, provisions a user and sets a password, and
    // each of those is its own privilege on the routes that perform it alone.
    if (principal === null) return json(401, { error: "authentication_required" });
    const roles = rolesOf(ctx, principal);
    if (
      !holdsAny(roles, ctx.platformAdminRoles) ||
      !holdsAny(roles, ctx.platformUserRoles) ||
      !holdsAny(roles, ctx.credentialAdminRoles)
    ) {
      return json(403, { error: "forbidden", detail: APPROVE_FORBIDDEN_DETAIL });
    }
    // Before anything is recorded, including the escalation refusal below.
    const unshaped = unrecordablePrincipal(principal);
    if (unshaped !== null) return unshaped;
    const parsed = ApproveBodySchema.safeParse(parsedBody ?? {});
    if (!parsed.success) {
      return json(400, {
        error: "invalid_request",
        fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".")))],
      });
    }
    const body = parsed.data;
    if (body.defaultCurrency !== undefined && !CURRENCY_RE.test(body.defaultCurrency)) {
      return json(400, { error: "currency_invalid", detail: "a currency is three uppercase letters" });
    }

    // 2. The request, as it stands now.
    const id = params["id"] ?? "";
    const request = await ctx.store.get(id);
    if (request === null) return json(404, { error: "access_request_not_found" });
    if (request.status !== "pending") return json(409, { error: "not_pending", status: request.status });
    const now = (ctx.clock ?? ((): Date => new Date()))();
    if (Date.parse(request.expiresAt) <= now.getTime()) return json(409, { error: "expired" });

    // 3. Effective values: the operator's edits win over what the customer asked for.
    const slug = body.slug ?? request.requestedSlug;
    if (slug === null) {
      return json(422, { error: "slug_required", detail: "the request named no slug; supply one" });
    }
    if (RESERVED_SLUG_SET.has(slug)) return json(422, { error: "slug_reserved" });
    const name = body.name ?? request.companyName;
    const email = normalizeEmail(body.email ?? request.email);
    const primaryRole = body.primaryRole ?? ctx.defaultPrimaryRole;
    const wantsChart = body.starterChart !== false;

    // 4. Stricter than provisioning's warning: a workspace whose only admin holds a role its
    // manifest does not declare can do nothing, which is a failed onboarding and not a caveat.
    const roleWarnings = await checkMembershipRoles(
      { tenantId: "", primaryRole, secondaryRoles: [] },
      () => Promise.resolve(ctx.newTenantRoles),
    );
    // Only a `not_declared` verdict refuses: `unresolved` means this process could not name the
    // set, and refusing on a fact nobody established would block every approval (ADR-0334).
    const undeclared = roleWarnings.find((w) => w.verdict === "not_declared");
    if (undeclared !== undefined) {
      return json(422, {
        error: "role_not_declared",
        detail: undeclared.detail,
        declaredRoles: undeclared.declaredRoles,
      });
    }
    const event: Omit<AccessRequestAuditEvent, "at"> = {
      operation: ACCESS_REQUEST_APPROVED_OPERATION,
      requestId: request.id,
      principalId: principal.principalId,
      roles,
      detail: {
        requestId: request.id,
        slug,
        primaryRole,
        attachedExistingUser: false,
        starterChart: wantsChart,
        ...(wantsChart
          ? { starterChartActingRoles: [...ctx.starterChartActingRoles], starterChartVersion: STARTER_CHART_VERSION }
          : {}),
      },
    };
    const escalation = await refuseEscalation(
      {
        principalRoles: ctx.principalRoles,
        platformAuthorityRoles: ctx.platformAuthorityRoles,
        ...(ctx.clock !== undefined ? { clock: ctx.clock } : {}),
        audit: (e: UserRegistryAuditEvent) =>
          ctx.audit({
            operation: e.operation,
            requestId: request.id,
            principalId: e.principalId,
            roles: e.roles,
            detail: e.detail,
            at: e.at,
          }),
      },
      principal,
      [primaryRole],
      {
        operation: ACCESS_REQUEST_APPROVED_OPERATION,
        tenantId: null,
        subjectUserId: null,
        principalId: principal.principalId,
        roles,
        detail: event.detail,
      },
    );
    if (escalation !== null) return escalation;

    // 5. An existing person is attached, never re-credentialed; a new one needs a first password.
    const existing = await ctx.users.getByEmail(email);
    let hash: string | null = null;
    if (existing !== null) {
      if (body.attachExistingUser !== true) {
        return json(409, {
          error: "user_exists",
          existingUser: { id: existing.id, status: existing.status },
        });
      }
      if (existing.status !== "active") {
        return json(409, { error: "user_not_active", existingUser: { id: existing.id, status: existing.status } });
      }
      // Account-takeover hazard. Anybody can file a request under any address, so an attacker can
      // file one under a victim's, have it approved and receive the password; the victim's own later
      // request would then be attached to the attacker-controlled user. Attaching therefore needs an
      // explicit statement that the operator has confirmed the existing user's owner out of band.
      if (body.confirmedExistingOwner !== true) {
        return json(400, {
          error: "existing_owner_unconfirmed",
          detail:
            "attaching an existing user needs confirmedExistingOwner: true, after confirming out of band " +
            "that the person who filed this request controls that user",
        });
      }
      if (body.password !== undefined) {
        return json(400, {
          error: "password_not_applicable",
          detail: "an existing user's password is never replaced by an approval",
        });
      }
    } else {
      const length = body.password === undefined ? 0 : passwordLength(body.password);
      if (body.password === undefined || length < ctx.minPasswordLength || length > MAX_PASSWORD_LENGTH) {
        return json(400, {
          error: "password_invalid",
          detail:
            `a new user's first password is required, ${ctx.minPasswordLength.toString()}..` +
            `${MAX_PASSWORD_LENGTH.toString()} characters`,
        });
      }
      // Before the transaction: a scrypt derivation inside it would hold a pooled connection, and
      // the tenant row's unique index, for as long as the derivation takes.
      hash = await ctx.hashPassword(body.password, `access-request:${request.id}`);
      if (hash === null) {
        return json(
          503,
          { error: "password_work_unavailable", detail: "too many password derivations are running; retry shortly" },
          { "retry-after": "1" },
        );
      }
    }
    const attached = existing !== null;
    const recorded: Omit<AccessRequestAuditEvent, "at"> = {
      ...event,
      detail: {
        ...event.detail,
        attachedExistingUser: attached,
        ...(attached ? { confirmedExistingOwner: true } : {}),
      },
    };

    // 6. Recorded before the write; an unrecordable approval is not performed (ADR-0313).
    const unrecordable = await record(ctx, recorded);
    if (unrecordable !== null) return unrecordable;

    const tenantInput = CreateTenantInputSchema.parse({ slug, name });
    const at = now.toISOString();
    const origin: AccessRequestOrigin = {
      kind: "access_request",
      requestId: request.id,
      termsVersion: request.termsVersion,
      termsAcceptedAt: request.termsAcceptedAt,
      contactEmailHmacSha256: contactEmailHmacSha256(ctx.contactEmailKey.key, request.email),
      contactEmailHmacPepperVersion: ctx.contactEmailKey.pepperVersion,
    };
    const settings: TenantSettings = {
      company: { name, email },
      ...(body.defaultCurrency !== undefined ? { defaults: { currency: body.defaultCurrency } } : {}),
      ...(body.paymentTermsDays !== undefined
        ? { finance: { defaultPaymentTermsDays: body.paymentTermsDays } }
        : {}),
    };

    // 7. One transaction. The new tenant's context is set here, first, rather than left to
    // `recordCreation`: the creation record, the membership and the settings are each refused by
    // their table's isolation policy without it, and an injected recorder is not a contract about
    // what it leaves set on `tx`. `meta.users` and `meta.access_requests` carry no RLS.
    let user: { readonly id: string; readonly email: string; readonly status: string } | null = null;
    let membership: MembershipRecord | null = null;
    let tenant: TenantRecord;
    try {
      tenant = await ctx.tenants.create(tenantInput, async (tx, created) => {
        await setTenantContextWithin(tx, created.id);
        try {
          await ctx.recordCreation(tx, { tenant: created, principalId: principal.principalId, at, origin });
        } catch (err) {
          throw new ApprovalUnrecordable(err);
        }
        const grant = {
          tenantId: created.id,
          primaryRole,
          secondaryRoles: [] as string[],
          status: "active" as const,
          abacAttributes: {},
        };
        if (existing !== null) {
          membership = await ctx.users.grantMembershipWithin(tx, { ...grant, userId: existing.id });
          user = { id: existing.id, email: existing.email, status: existing.status };
        } else {
          const provisioned = await ctx.users.provisionWithin(
            tx,
            { email, displayName: request.contactName },
            grant,
          );
          membership = provisioned.membership;
          user = { id: provisioned.user.id, email: provisioned.user.email, status: provisioned.user.status };
          if (hash !== null) {
            const set = await ctx.credentials.setCredentialWithin(tx, provisioned.user.id, hash);
            if (!set) throw new Error("the user provisioned in this transaction was not found");
          }
        }
        await ctx.settings.putWithin(tx, created.id, settings, principal.principalId);
        const landed = await ctx.store.markApprovedWithin(tx, request.id, {
          decidedBy: principal.principalId,
          decidedAt: at,
          approvedTenantId: created.id,
          approvedUserId: user.id,
        });
        if (!landed) throw new ApprovalLost();
      });
    } catch (err) {
      if (err instanceof ApprovalUnrecordable) {
        console.error("[access-request] tenant creation not recorded, so not performed:", err.underlying);
        return json(503, {
          error: "audit_unavailable",
          detail: "a tenant cannot be created while its creation cannot be recorded",
        });
      }
      if (err instanceof ApprovalLost) {
        return recordRefusal(ctx, recorded, "not_pending", json(409, { error: "not_pending" }));
      }
      if (err instanceof DuplicateTenantError) {
        return recordRefusal(ctx, recorded, "tenant_exists", json(409, { error: "tenant_exists", slug }));
      }
      if (err instanceof DuplicateUserError) {
        return recordRefusal(ctx, recorded, "user_exists", json(409, { error: "user_exists" }));
      }
      if (err instanceof DuplicateMembershipError) {
        return recordRefusal(ctx, recorded, "membership_exists", json(409, { error: "membership_exists" }));
      }
      if (err instanceof UnknownPrincipalError) {
        return recordRefusal(ctx, recorded, "unknown_principal", json(422, { error: "unknown_principal" }));
      }
      throw err;
    }
    ctx.onApproved?.(request.id, tenant.slug);
    // 8. After the commit, because each account is written through the create handler, which opens
    // its own transaction (ADR-0465). The workspace is approved whatever happens here: a chart that
    // fails or is partly refused is reported on the 201, and the console's "create starter chart"
    // act finishes it, since the provisioning is idempotent.
    const starterChart: StarterChartAnswer = wantsChart
      ? await provisionChart(ctx, tenant.id, request.id, principal.principalId)
      : { outcome: "not_requested" };
    return json(
      201,
      {
        tenant,
        user,
        membership,
        attachedExistingUser: attached,
        passwordSet: hash !== null,
        starterChart,
      },
      { "cache-control": "no-store" },
    );
  };
}

/** `platform-users.ts`' segment pattern: what keeps `stats` and `reject-pending` off the `{id}` route. */
const UUID_SEGMENT_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

function route(
  operationId: string,
  method: RouteDefinition["method"],
  segments: ReadonlyArray<string | { param: string; pattern?: string }>,
): RouteDefinition {
  const pathSegments: PathSegment[] = segments.map((s) =>
    typeof s === "string"
      ? { kind: "literal", value: s }
      : { kind: "parameter", name: s.param, pattern: s.pattern ?? null },
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

/** The operator's half, to inject via the gateway's `extraRoutes` hook. */
export function buildAccessRequestRoutes(
  ctx: AccessRequestRoutesContext,
): readonly ExtraGatewayRoute[] {
  if (typeof ctx.audit !== "function") {
    throw new Error("access-request routes require an auditor: every decision is recorded first");
  }
  const base = ["v1", "platform", "access-requests"] as const;
  const idSeg = { param: "id", pattern: UUID_SEGMENT_PATTERN };
  return [
    { route: route("platform.access_requests.list", "GET", [...base]), handler: buildListHandler(ctx) },
    // Ahead of every `{id}` route; the uuid pattern on `{id}` is what actually separates them.
    {
      route: route("platform.access_requests.stats", "GET", [...base, "stats"]),
      handler: buildStatsHandler(ctx),
    },
    {
      route: route("platform.access_requests.reject_pending", "POST", [...base, "reject-pending"]),
      handler: buildRejectPendingHandler(ctx),
    },
    {
      route: route("platform.access_requests.approve", "POST", [...base, idSeg, "approve"]),
      handler: buildApproveHandler(ctx),
    },
    {
      route: route("platform.access_requests.reject", "POST", [...base, idSeg, "reject"]),
      handler: buildRejectHandler(ctx),
    },
  ];
}

/* --------------------------------------------------------------------- sweep */

export const ACCESS_REQUEST_SWEEP_INTERVAL_MS = 3_600_000;
export const ACCESS_REQUEST_SWEEP_FIRST_RUN_MS = 60_000;

export interface AccessRequestSweeperOptions {
  readonly store: Pick<PostgresAccessRequestStore, "sweep">;
  readonly retentionDays: number;
  readonly intervalMs?: number;
  readonly firstRunDelayMs?: number;
  readonly clock?: () => Date;
  readonly log: (line: string) => void;
  readonly onError: (line: string) => void;
}

/** Hourly, in process. Logs only when something was deleted, and never throws out of a pass. */
export class AccessRequestSweeper {
  private first: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: AccessRequestSweeperOptions) {}

  start(): void {
    if (this.first !== null || this.timer !== null) return;
    this.first = setTimeout(() => {
      this.first = null;
      void this.runOnce();
      this.timer = setInterval(() => {
        void this.runOnce();
      }, this.options.intervalMs ?? ACCESS_REQUEST_SWEEP_INTERVAL_MS);
      this.timer.unref();
    }, this.options.firstRunDelayMs ?? ACCESS_REQUEST_SWEEP_FIRST_RUN_MS);
    this.first.unref();
  }

  stop(): void {
    if (this.first !== null) clearTimeout(this.first);
    if (this.timer !== null) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  async runOnce(): Promise<{ readonly expiredDeleted: number; readonly decidedDeleted: number } | null> {
    try {
      const result = await this.options.store.sweep({
        now: (this.options.clock ?? ((): Date => new Date()))(),
        retentionDays: this.options.retentionDays,
      });
      if (result.expiredDeleted > 0 || result.decidedDeleted > 0) {
        this.options.log(
          `[access-request] swept ${result.expiredDeleted.toString()} expired pending and ` +
            `${result.decidedDeleted.toString()} decided request(s) older than ` +
            `${this.options.retentionDays.toString()}d`,
        );
      }
      return result;
    } catch (err) {
      this.options.onError(
        `[access-request] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
