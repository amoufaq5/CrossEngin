import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import { isoInstant, requireIsoInstant, scopeFilter, type PgConnection } from "@crossengin/kernel-pg";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import { withTenantContext } from "@crossengin/operate-runtime-pg";
import { z } from "zod";

import {
  checkMembershipRoles,
  type MembershipRoleDirectory,
  type MembershipRoleWarning,
} from "./membership-role-fence.js";
import { roleNameIsScopeSafe } from "./token-mint.js";

/**
 * The writer `meta.users` and `meta.user_tenant_membership` never had.
 *
 * Both tables were declared in Phase 1 and **every** reference to them in the workspace is a
 * comment or a read: `recipient-resolver.ts` joins them to resolve an audience, and nothing else
 * touches either. ADR-0334's census filed them `out_of_band`, on the true observation that SSO and
 * SCIM are contracts-only so no federated login can create a user — but out-of-band provisioning
 * does not exist either. `deploy/README.md` tells an operator to put a real `meta.users.id` into an
 * `--api-key` spec, and there is no documented way to make one.
 *
 * The cost is not that the registry is empty. It is that **42 of the catalog's columns carry a
 * `NOT NULL` foreign key into `meta.users`**, nine of them on tables with a live writer — so nine
 * stores cannot insert a single row, and the failure mode is a 23503 at the first write rather than
 * anything a boot check would catch. Verified live as a non-owner role against a fresh cluster:
 * eight of the nine refuse directly with `Key is not present in table "users"`, and the ninth
 * (`meta.access_review_decisions`) cannot even be *attempted*, because its campaign parent is
 * refused by the same constraint. `design-notifications.ts` already works around a nullable one in
 * exactly these words: *"requested_by is a RESTRICT foreign key into meta.users, and the reviewer
 * is a platform operator with no row there — attributing them would fail the insert."*
 *
 * ## Why here, and not a new package
 *
 * `meta.tenants` is the other platform registry and its store is `platform-admin.ts`, in this app;
 * `recipient-resolver.ts`, the only existing reader of these two tables, is in this app as well.
 * `sso` is contracts-only with no `-runtime`/`-pg` sibling, so the layered home would have to be
 * *created* — two packages, their tsconfigs and their typecheck overlays — to hold one store that
 * only this binary serves. The layering convention earns its keep where a contract is executed in
 * process and persisted separately; a platform registry read and written in one place by one
 * process is the case `platform-admin.ts` already settled.
 *
 * ## The two tables are not the same kind of table
 *
 * `meta.users` has **no `tenant_id` and no RLS** — it is platform-wide, like `meta.tenants`, so its
 * statements carry no scope predicate and must not: naming a column the table does not have is
 * ADR-0332's `default_value` defect. `meta.user_tenant_membership` carries `tenant_id NOT NULL` and
 * exactly **one** `ALL`-scope isolation policy with no platform arm, so every statement against it
 * runs inside `withTenantContext` *and* binds the strict `scopeFilter` beside it — a table's owner
 * bypasses its policies and connecting as the owner is an ordinary deployment (ADR-0333). The
 * inclusive `scopeFilterWithPlatform` would be wrong here and not merely wider: `tenant_id` is
 * `NOT NULL`, so a platform-scope membership cannot exist and an arm matching one could only ever
 * widen a read past what a non-owner is shown.
 *
 * ## Retirement is a status, and that is forced
 *
 * `users_status_check` admits `active` / `suspended` / `deleted`, and `deleted` is a *status* rather
 * than a `DELETE`. It has to be: 42 `NOT NULL` references mean a user who has done
 * anything at all cannot be removed from the table, which is the very property ADR-0318 and
 * ADR-0321 called wrong for a *historical* column and which is correct for a membership. So
 * `retire` sets the status and the row stays.
 */

/* ------------------------------------------------------------------ contracts */

/** `meta.users.status`' CHECK, which is the whole of this vocabulary. */
export const USER_STATUSES = ["active", "suspended", "deleted"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * `deleted` is terminal and `suspended` is not, which is the one asymmetry worth stating: a
 * suspension is an operational hold and a retirement is the end of a principal's life. Nothing
 * deletes the row (those references forbid it), so `deleted` with no outbound edge is
 * the only way to say "this identity is spent" without lying about the row's existence.
 */
export const USER_STATUS_TRANSITIONS: Readonly<Record<UserStatus, readonly UserStatus[]>> =
  Object.freeze({
    active: ["suspended", "deleted"],
    suspended: ["active", "deleted"],
    deleted: [],
  });

export function canTransitionUser(from: UserStatus, to: UserStatus): boolean {
  return (USER_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

/** `user_tenant_membership_status_check`. */
export const MEMBERSHIP_STATUSES = ["active", "invited", "revoked"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/**
 * `revoked -> active` is permitted and `invited -> revoked` is too: a membership is a live relation
 * that an operator grants, withdraws and restores, unlike a user's `deleted`. Restoring is a
 * re-grant of the *same* membership row rather than a new one, because the unique constraint is
 * `(user_id, tenant_id)` — there is exactly one membership per pair by construction.
 */
export const MEMBERSHIP_STATUS_TRANSITIONS: Readonly<
  Record<MembershipStatus, readonly MembershipStatus[]>
> = Object.freeze({
  invited: ["active", "revoked"],
  active: ["revoked"],
  revoked: ["active"],
});

export function canTransitionMembership(from: MembershipStatus, to: MembershipStatus): boolean {
  return (MEMBERSHIP_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

/** `users_phone_e164_check`, restated here so a 400 lands before the database raises a 23514. */
export const PHONE_E164_RE = /^\+[1-9][0-9]{6,14}$/;

/**
 * Folds an email to lower case before it is stored or looked up.
 *
 * `users_email_key` is a plain unique constraint, so Postgres compares it byte-for-byte and
 * `Ada@x.com` and `ada@x.com` would both be insertable — two identities for one person, each with
 * its own `meta.users.id`, and therefore its own read state, its own preferences and its own
 * audience membership. RFC 5321 §2.4 does make the local part formally case-sensitive, and this
 * repo has already weighed that once and come down the same way:
 * `normalizeRecipientAddress` lowercases an email's local part *"because no production provider
 * distinguishes them and the alternative is a row that never matches"*. The same reasoning applies
 * with more force to an identity than to a suppression.
 *
 * Deliberately **not** done: stripping `+tag` subaddressing or a display name. ADR-0302 refused
 * both for a suppression because they widen the rule past the address that was observed; here they
 * would merge two people who chose to be distinguishable.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Named in the refusal so the operator reads the consequence rather than the rule.
 *
 * It names **whitespace only** and not emptiness, which `roleNameIsScopeSafe` also refuses: a `""`
 * never reaches the refinement, because `.min(1)` settles it first with zod's own accurate
 * `too_small`. A message describing a case it cannot fire for is ADR-0361's class in a string.
 *
 * Exported because the test asserts this exact text: a paraphrase in the schema and a paraphrase in
 * the test agree with each other and with nothing.
 */
export const ROLE_NAME_SCOPE_SAFE_MESSAGE =
  "a role name may not contain whitespace: the JWT scope claim is space-delimited, so this name" +
  " would be granted once and read back as two roles, neither of which the manifest declares";

/**
 * Re-exported from `token-mint.js`, which owns it because it owns the delimiter it is about. It is
 * re-exported here, rather than merely imported, because this is the module a reader comes to when
 * they meet the 400 — and the reasoning below is about the grant, not about the claim.
 *
 * **Whether a role name survives a round trip through the JWT `scope` claim.**
 *
 * `mintSessionToken` joins a session's roles with a single space and the gateway's JWT stage splits
 * them back on one (`scope.split(" ").filter((s) => s.length > 0)`), so the claim cannot carry a
 * name containing whitespace: `"hr manager"` is granted once and arrives as `["hr", "manager"]`,
 * and an empty name arrives as nothing at all. Either way the session holds something other than
 * what was granted, silently — an undeclared role contributes nothing (`redaction.ts` maps an
 * unknown name to `UNPRIVILEGED_ROLE` and `resolveEffectiveRoles` visits it with `"skip"`), so the
 * symptom is a role that was granted and does not work.
 *
 * Emptiness is in the predicate and **not** in the schema's message, because
 * `z.string().min(1)` settles that case first and zod's own `too_small` is the accurate sentence
 * for it; the predicate still answers for both so a caller that is not a zod field — the mint — has
 * one question to ask rather than two.
 *
 * Deliberately not enforced in the kernel, which is where a rule about role names would otherwise
 * belong: `--api-key key:role:tenant` sets `grantedScopes: [spec.role]` with no split at all, so a
 * role name containing a space is legitimately holdable by an api-key principal and a kernel
 * refusal would refuse a configuration that works. The fence belongs where the name is typed in.
 */
export { roleNameIsScopeSafe };

/**
 * The write-path role name. Per **field** rather than a `superRefine` on the object, which is
 * load-bearing: a top-level refinement makes `GrantMembershipInputSchema` a `ZodEffects`, which has
 * no `.omit()` — and both of its consumers derive from it that way
 * (`ProvisionBodySchema.membership`, `GrantBodySchema`). A field-level refusal is inherited through
 * `.omit()` by construction, and its error path names the offending element.
 */
const ScopeSafeRoleNameSchema = z
  .string()
  .min(1)
  .refine(roleNameIsScopeSafe, { message: ROLE_NAME_SCOPE_SAFE_MESSAGE });

export const UserRecordSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string().min(1).nullable(),
    phoneE164: z.string().regex(PHONE_E164_RE).nullable(),
    status: z.enum(USER_STATUSES),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    lastLoginAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type UserRecord = z.infer<typeof UserRecordSchema>;

/**
 * `primaryRole` and `secondaryRoles` are **not** `ScopeSafeRoleNameSchema` here, and the asymmetry
 * against `GrantMembershipInputSchema` is the decision rather than an oversight.
 *
 * This is the **read** schema: `rowToMembership` parses every row through it, so refusing a
 * whitespace-bearing name here would make an already-stored membership *unreadable* — which takes
 * `membershipFor` down, and with it the login, the ABAC attribute directory and the member list, for
 * a user whose row was written before the fence existed. There is no remedy from that state either:
 * the row cannot be read, so no surface can show it and the operator cannot see which name to
 * correct. `mintSessionToken`'s throw is the strictly narrower failure — it names the role, leaves
 * every read working, and the grant route is where the name can actually be fixed.
 *
 * So a row written before this fence stays readable and fails at the mint. ADR-0289's rule applies
 * to a row edited into a shape the *contract* forbids; this is a shape the contract still admits and
 * only one consumer cannot carry.
 */
export const MembershipRecordSchema = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    tenantId: z.string().uuid(),
    primaryRole: z.string().min(1),
    secondaryRoles: z.array(z.string().min(1)),
    status: z.enum(MEMBERSHIP_STATUSES),
    abacAttributes: z.record(z.unknown()),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type MembershipRecord = z.infer<typeof MembershipRecordSchema>;

/**
 * `id` is accepted, which is unusual here and is the point of the whole lane: the ids that need a
 * row are the ones a deployment has *already* committed to — a principal named in an
 * `--api-key key:role:tenant:principal` spec, or a `createdBy` in an access-reviews config file.
 * A server-minted id could not satisfy either, so provisioning would still leave the nine writers
 * refused. Compare ADR-0321, which generates a deletion request's id server-side precisely because
 * a caller-chosen one that collided would hand back another tenant's request: there the id is a
 * *handle the server issues*, here it is a *fact the deployment already holds*.
 */
export const CreateUserInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    email: z.string().email(),
    displayName: z.string().min(1).optional(),
    phoneE164: z.string().regex(PHONE_E164_RE).optional(),
  })
  .strict();
export type CreateUserInput = z.infer<typeof CreateUserInputSchema>;

export const GrantMembershipInputSchema = z
  .object({
    userId: z.string().uuid(),
    tenantId: z.string().uuid(),
    primaryRole: ScopeSafeRoleNameSchema,
    secondaryRoles: z.array(ScopeSafeRoleNameSchema).default([]),
    abacAttributes: z.record(z.unknown()).default({}),
    /**
     * `invited` is expressible and is **not** the default. A default is applied to silence
     * (ADR-0334's rule for `disposition`), and silence must not decide whether a membership grants
     * access now or only promises it: `recipient-resolver.ts` filters on `m.status = 'active'`, so
     * the two answers differ in whether this person is notified at all.
     */
    status: z.enum(MEMBERSHIP_STATUSES),
  })
  .strict();
export type GrantMembershipInput = z.infer<typeof GrantMembershipInputSchema>;

/* --------------------------------------------------------------------- store */

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

const USER_COLUMNS =
  "id, email, display_name, phone_e164, status, created_at, updated_at, last_login_at";

const MEMBERSHIP_COLUMNS =
  "id, user_id, tenant_id, primary_role, secondary_roles, status, abac_attributes," +
  " created_at, updated_at";

const DEFAULT_LIMIT = 50;

/**
 * The page-size ceiling both registry lists clamp to.
 *
 * Exported under a qualified name rather than as `MAX_LIMIT`, which **eleven** sibling modules in
 * this app hold privately and none exports: `index.ts` re-exports this file with `export *`, so the
 * bare name would be a collision waiting for the second of them to be exported.
 */
export const REGISTRY_LIST_MAX_LIMIT = 200;

/** Thrown when an INSERT hits `users_email_key` → maps to 409. */
export class DuplicateUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateUserError";
  }
}

/** Thrown when a membership INSERT hits `user_tenant_membership_user_tenant_key` → 409. */
export class DuplicateMembershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateMembershipError";
  }
}

/**
 * Thrown when a membership names a user (or a tenant) that does not exist → 422.
 *
 * Separate from the duplicate errors because it is the one refusal this surface exists to make
 * legible: a membership is the join, so a 23503 here means the registry was asked to grant access
 * to a principal it has never heard of. Reported as 422 rather than 404, since the path segment
 * resolves and it is the *body* that names the absent party.
 */
export class UnknownPrincipalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownPrincipalError";
  }
}

export interface UserListQuery {
  readonly status?: UserStatus;
  /**
   * An **exact** match, folded through `normalizeEmail` — the same function the write path uses, so
   * a lookup for `Alice@Example.com` finds the row stored as `alice@example.com`.
   *
   * Exact and deliberately not a prefix or a substring: `users_email_key` is a UNIQUE constraint,
   * so an equality resolves one indexed row, where a `LIKE`/`ILIKE` is the unindexed scan that is a
   * standing open defect on this repo's entity list surfaces. Offering a substring search here
   * would import it into the registry every console page load walks.
   */
  readonly email?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface UserListPage {
  readonly data: readonly UserRecord[];
  readonly nextCursor: string | null;
}

export interface MembershipListPage {
  readonly data: readonly MembershipRecord[];
  readonly nextCursor: string | null;
}

export type UserStatusCounts = Readonly<Record<UserStatus, number>> & { readonly total: number };

function emptyUserStatusCounts(): Record<UserStatus, number> {
  return Object.fromEntries(USER_STATUSES.map((s) => [s, 0])) as Record<UserStatus, number>;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, "utf8").toString("base64url");
}

/**
 * The offset a cursor names, or `null` when it is not one this surface issued.
 *
 * `null` rather than `0`, which is the whole of ADR-0359's class on this parameter: a cursor that
 * decoded to 0 handed the caller page 1 under a 200 they could not tell from the page they asked
 * for. `decodeAuditReadCursor` already answers this way and its store throws on the `null`.
 *
 * An **absent** cursor is not a refusal — it is the first page — so it is answered by the caller
 * rather than folded in here. That is what lets one function serve both the handlers' 400 and the
 * store's throw without either re-deciding the format.
 */
export function decodeUserListCursor(cursor: string): number | null {
  // `Buffer.from(…, "base64url")` drops characters outside the alphabet rather than throwing, so
  // the shape test on the decoded text is the whole validation and there is nothing to catch.
  const match = /^o:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (match === null) return null;
  const offset = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(offset) ? offset : null;
}

/** Whether a raw query value is a cursor this surface issued — the handlers' half of that answer. */
export function isUserListCursor(raw: string): boolean {
  return decodeUserListCursor(raw) !== null;
}

function cursorOffset(cursor: string | undefined): number {
  if (cursor === undefined || cursor.length === 0) return 0;
  const offset = decodeUserListCursor(cursor);
  // Refuses rather than falling to 0. The handlers 400 an unreadable cursor before the store is
  // reached, so this answers a direct caller — and answering 0 there would be the same wrong page
  // under a different surface.
  if (offset === null) throw new Error(`invalid user list cursor: ${JSON.stringify(cursor)}`);
  return offset;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  return n > REGISTRY_LIST_MAX_LIMIT ? REGISTRY_LIST_MAX_LIMIT : n;
}

function pgCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function isUniqueViolation(err: unknown): boolean {
  if (pgCode(err) === "23505") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /duplicate key|unique constraint|already exists/i.test(message);
}

/**
 * Whether a foreign-key violation names `meta.users` as the missing parent.
 *
 * Read off the constraint name and the detail rather than off the column, because the detail is
 * where Postgres puts the parent relation and a membership insert can fail on either of its two
 * references. The caller needs to tell "no such user" from "no such tenant" — they are different
 * operator mistakes — so both are reported, and the message carries whichever Postgres named.
 */
function foreignKeyParent(err: unknown): string | null {
  if (pgCode(err) !== "23503") return null;
  const e = err as { detail?: unknown; constraint?: unknown; message?: unknown };
  const text = `${String(e.detail ?? "")} ${String(e.constraint ?? "")} ${String(e.message ?? "")}`;
  if (/\busers\b/.test(text)) return "meta.users";
  if (/\btenants\b/.test(text)) return "meta.tenants";
  return "unknown";
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

export interface PostgresUserStoreOptions {
  readonly schema?: string;
}

/**
 * Cross-tenant CRUD over the platform user registry, plus the tenant-scoped membership join.
 *
 * One class for two tables, as `PostgresReadStateStore` is for its two: a membership is meaningless
 * without its user, and `provision` writes both in one transaction so a user cannot be left in the
 * registry with no tenant to belong to.
 *
 * Every row is re-parsed through its zod schema (ADR-0289). A row edited into a state the contract
 * forbids but the CHECK permits — an email that is not an address, a `phone_e164` that drifted past
 * the pattern a later migration widened — **raises** rather than being served, because this registry
 * is what every one of those foreign keys resolves against and a principal served wrong is a
 * principal acted on wrong.
 */
export class PostgresUserStore {
  private readonly users: string;
  private readonly memberships: string;

  constructor(
    private readonly conn: PgConnection,
    options: PostgresUserStoreOptions = {},
  ) {
    const schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.users = `${schema}.users`;
    this.memberships = `${schema}.user_tenant_membership`;
  }

  rowToUser(row: Record<string, unknown>): UserRecord {
    return UserRecordSchema.parse({
      id: String(row["id"]),
      email: String(row["email"]),
      displayName: row["display_name"] == null ? null : String(row["display_name"]),
      phoneE164: row["phone_e164"] == null ? null : String(row["phone_e164"]),
      status: String(row["status"]),
      createdAt: requireIsoInstant(row["created_at"], "users.created_at"),
      updatedAt: requireIsoInstant(row["updated_at"], "users.updated_at"),
      lastLoginAt: isoInstant(row["last_login_at"]),
    });
  }

  rowToMembership(row: Record<string, unknown>): MembershipRecord {
    return MembershipRecordSchema.parse({
      id: String(row["id"]),
      userId: String(row["user_id"]),
      tenantId: String(row["tenant_id"]),
      primaryRole: String(row["primary_role"]),
      secondaryRoles: toStringArray(row["secondary_roles"]),
      status: String(row["status"]),
      abacAttributes: toRecord(row["abac_attributes"]),
      createdAt: requireIsoInstant(row["created_at"], "user_tenant_membership.created_at"),
      updatedAt: requireIsoInstant(row["updated_at"], "user_tenant_membership.updated_at"),
    });
  }

  /**
   * Creates a user and, when one is supplied, their first membership — in **one transaction**.
   *
   * The two halves commit together for the reason ADR-0319 gives for the deletion pipeline: run
   * separately there is a window in which the registry holds a person who belongs to no tenant, and
   * the only thing that could later distinguish that from an orphan nobody meant to create is a log
   * line. `meta.users` has no RLS, so writing it inside a tenant-scoped transaction is harmless; the
   * membership half needs the context and gets it.
   */
  async provision(
    input: CreateUserInput,
    membership?: Omit<GrantMembershipInput, "userId">,
  ): Promise<{ readonly user: UserRecord; readonly membership: MembershipRecord | null }> {
    const email = normalizeEmail(input.email);
    const params: unknown[] = [email, input.displayName ?? null, input.phoneE164 ?? null];
    if (input.id !== undefined) params.push(input.id);

    // Two complete statements rather than one with an interpolated column list. A column list
    // assembled from a fragment is unreadable to `pg-column-coverage`'s scanner, which reports it
    // `unresolved_columns` — and ADR-0333 is explicit that an unparsed statement is *reported, not
    // skipped*, so a declared gap here would buy a silence exactly where that rule exists to stop
    // one. Both forms are literal, so both are checked against `META_TABLES`.
    const insertUser =
      input.id === undefined
        ? `INSERT INTO ${this.users} (email, display_name, phone_e164, status)` +
          ` VALUES ($1, $2, $3, 'active') RETURNING ${USER_COLUMNS}`
        : `INSERT INTO ${this.users} (id, email, display_name, phone_e164, status)` +
          ` VALUES ($4::uuid, $1, $2, $3, 'active') RETURNING ${USER_COLUMNS}`;

    const run = async (tx: PgConnection): Promise<{
      user: UserRecord;
      membership: MembershipRecord | null;
    }> => {
      const created = await tx.query<Record<string, unknown>>(insertUser, params);
      const row = created.rows[0];
      if (row === undefined) throw new Error("INSERT INTO users did not return a row");
      const user = this.rowToUser(row);
      if (membership === undefined) return { user, membership: null };
      const granted = await this.insertMembership(tx, { ...membership, userId: user.id });
      return { user, membership: granted };
    };

    try {
      if (membership === undefined) return await this.conn.transaction(run);
      return await withTenantContext(this.conn, membership.tenantId, run);
    } catch (err) {
      throw this.translate(err, email, membership?.tenantId ?? null);
    }
  }

  private translate(err: unknown, email: string, tenantId: string | null): unknown {
    const parent = foreignKeyParent(err);
    if (parent !== null) {
      return new UnknownPrincipalError(
        `membership references a row that does not exist in ${parent}` +
          (tenantId === null ? "" : ` (tenant=${tenantId})`),
      );
    }
    if (isUniqueViolation(err)) {
      return new DuplicateUserError(`a user already holds this identity (email=${email})`);
    }
    return err;
  }

  async getById(id: string): Promise<UserRecord | null> {
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${USER_COLUMNS} FROM ${this.users} WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.rowToUser(row);
  }

  async getByEmail(email: string): Promise<UserRecord | null> {
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${USER_COLUMNS} FROM ${this.users} WHERE email = $1`,
      [normalizeEmail(email)],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.rowToUser(row);
  }

  async list(query: UserListQuery = {}): Promise<UserListPage> {
    const limit = clampLimit(query.limit);
    const offset = cursorOffset(query.cursor);
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (query.status !== undefined) {
      params.push(query.status);
      clauses.push(`status = $${String(params.length)}`);
    }
    if (query.email !== undefined) {
      params.push(normalizeEmail(query.email));
      clauses.push(`email = $${String(params.length)}`);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    params.push(limit + 1);
    const limitParam = params.length;
    params.push(offset);
    const offsetParam = params.length;
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${USER_COLUMNS} FROM ${this.users}${where}` +
        ` ORDER BY created_at DESC, id LIMIT $${String(limitParam)} OFFSET $${String(offsetParam)}`,
      params,
    );
    const rows = result.rows.map((r) => this.rowToUser(r));
    const hasMore = rows.length > limit;
    return {
      data: hasMore ? rows.slice(0, limit) : rows,
      nextCursor: hasMore ? encodeCursor(offset + limit) : null,
    };
  }

  /**
   * A status change whose **source** state is re-asserted inside the `UPDATE` predicate — the row is
   * the lock (ADR-0321), and stronger than reading first because a caller cannot defeat it by
   * reusing what it read. `null` conflates "no such user" with "not in one of `from`" on purpose,
   * exactly as `PostgresTenantStore.transitionStatus` does: both mean the caller's premise was wrong.
   */
  async transitionStatus(
    id: string,
    to: UserStatus,
    from: readonly UserStatus[],
  ): Promise<UserRecord | null> {
    if (from.length === 0) return null;
    const placeholders = from.map((_s, i) => `$${String(i + 3)}`).join(", ");
    const result = await this.conn.query<Record<string, unknown>>(
      `UPDATE ${this.users} SET status = $2, updated_at = now()` +
        ` WHERE id = $1 AND status IN (${placeholders}) RETURNING ${USER_COLUMNS}`,
      [id, to, ...from],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.rowToUser(row);
  }

  async counts(): Promise<UserStatusCounts> {
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT status, COUNT(*)::int AS count FROM ${this.users} GROUP BY status`,
    );
    const byStatus = emptyUserStatusCounts();
    let total = 0;
    for (const row of result.rows) {
      const status = String(row["status"]);
      const count = Number(row["count"]);
      // A status the contract does not declare still counts toward `total`, so the figures add up
      // against a database whose CHECK was widened past it by hand — `platform-admin.ts`'s rule,
      // and here a half-applied widening is likelier, since this CHECK has never had a writer.
      if (status in byStatus) byStatus[status as UserStatus] += count;
      total += count;
    }
    return { ...byStatus, total };
  }

  /* ----------------------------------------------------------- memberships */

  private async insertMembership(
    tx: PgConnection,
    input: GrantMembershipInput,
  ): Promise<MembershipRecord> {
    const result = await tx.query<Record<string, unknown>>(
      `INSERT INTO ${this.memberships}` +
        " (user_id, tenant_id, primary_role, secondary_roles, status, abac_attributes)" +
        " VALUES ($1::uuid, $2::uuid, $3, $4::text[], $5, $6::jsonb)" +
        ` RETURNING ${MEMBERSHIP_COLUMNS}`,
      [
        input.userId,
        input.tenantId,
        input.primaryRole,
        [...input.secondaryRoles],
        input.status,
        JSON.stringify(input.abacAttributes),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("INSERT INTO user_tenant_membership did not return a row");
    return this.rowToMembership(row);
  }

  /** Grants a membership to an existing user. Refuses rather than upserting — see `regrant`. */
  async grantMembership(input: GrantMembershipInput): Promise<MembershipRecord> {
    try {
      return await withTenantContext(this.conn, input.tenantId, (tx) =>
        this.insertMembership(tx, input),
      );
    } catch (err) {
      const parent = foreignKeyParent(err);
      if (parent !== null) {
        return Promise.reject(
          new UnknownPrincipalError(
            `cannot grant a membership: ${parent} has no row for the id this grant names` +
              ` (user=${input.userId} tenant=${input.tenantId})`,
          ),
        );
      }
      if (isUniqueViolation(err)) {
        return Promise.reject(
          new DuplicateMembershipError(
            `this user already has a membership in this tenant` +
              ` (user=${input.userId} tenant=${input.tenantId});` +
              " change its status rather than granting a second",
          ),
        );
      }
      throw err;
    }
  }

  async membershipFor(tenantId: string, userId: string): Promise<MembershipRecord | null> {
    const scope = scopeFilter(tenantId, 1);
    const result = await withTenantContext(this.conn, tenantId, (tx) =>
      tx.query<Record<string, unknown>>(
        `SELECT ${MEMBERSHIP_COLUMNS} FROM ${this.memberships}` +
          ` WHERE ${scope.sql} AND user_id = $2::uuid`,
        [...scope.params, userId],
      ),
    );
    const row = result.rows[0];
    return row === undefined ? null : this.rowToMembership(row);
  }

  async membershipsForTenant(
    tenantId: string,
    query: { readonly status?: MembershipStatus; readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<MembershipListPage> {
    const limit = clampLimit(query.limit);
    const offset = cursorOffset(query.cursor);
    const scope = scopeFilter(tenantId, 1);
    const params: unknown[] = [...scope.params];
    let where = ` WHERE ${scope.sql}`;
    if (query.status !== undefined) {
      params.push(query.status);
      where += ` AND status = $${String(params.length)}`;
    }
    params.push(limit + 1);
    const limitParam = params.length;
    params.push(offset);
    const offsetParam = params.length;
    const result = await withTenantContext(this.conn, tenantId, (tx) =>
      tx.query<Record<string, unknown>>(
        `SELECT ${MEMBERSHIP_COLUMNS} FROM ${this.memberships}${where}` +
          ` ORDER BY created_at DESC, id LIMIT $${String(limitParam)} OFFSET $${String(offsetParam)}`,
        params,
      ),
    );
    const rows = result.rows.map((r) => this.rowToMembership(r));
    const hasMore = rows.length > limit;
    return {
      data: hasMore ? rows.slice(0, limit) : rows,
      nextCursor: hasMore ? encodeCursor(offset + limit) : null,
    };
  }

  /**
   * The membership equivalent of `transitionStatus`, with the same in-predicate guard and the
   * scope predicate ANDed in — strict, because a write that matched another scope's row would move
   * a membership between tenants rather than merely read one too widely (ADR-0333).
   */
  async transitionMembershipStatus(
    tenantId: string,
    userId: string,
    to: MembershipStatus,
    from: readonly MembershipStatus[],
  ): Promise<MembershipRecord | null> {
    if (from.length === 0) return null;
    // `tenant_id` is NOT NULL on this table, so `scopeFilter` always binds exactly one parameter
    // here and the first three positions are fixed. Written literally for that reason: a `$${…}` in
    // the `SET` clause is `unresolved_columns` to `pg-column-coverage`'s scanner, and the dynamic
    // part belongs in the `WHERE`, which is deliberately not column-checked (`$n`, casts and
    // aliases produce both misses and wrong hits without a parser).
    const scope = scopeFilter(tenantId, 1);
    const placeholders = from.map((_s, i) => `$${String(4 + i)}`).join(", ");
    const result = await withTenantContext(this.conn, tenantId, (tx) =>
      tx.query<Record<string, unknown>>(
        `UPDATE ${this.memberships} SET status = $3, updated_at = now()` +
          ` WHERE ${scope.sql} AND user_id = $2::uuid` +
          ` AND status IN (${placeholders}) RETURNING ${MEMBERSHIP_COLUMNS}`,
        [...scope.params, userId, to, ...from],
      ),
    );
    const row = result.rows[0];
    return row === undefined ? null : this.rowToMembership(row);
  }
}

/* -------------------------------------------------------------------- routes */

export interface UserRegistryAuditEvent {
  /** `platform.user_provisioned` / `_retired` / `platform.membership_granted` / `_transitioned`. */
  readonly operation: string;
  /** The tenant the act is *about*: the membership's tenant, or null for a bare user write. */
  readonly tenantId: string | null;
  readonly subjectUserId: string | null;
  readonly principalId: string | null;
  readonly roles: readonly string[];
  readonly detail: Readonly<Record<string, unknown>>;
  readonly at: string;
}

export type UserRegistryAuditor = (event: UserRegistryAuditEvent) => Promise<void>;

export const USER_PROVISIONED_OPERATION = "platform.user_provisioned";
export const USER_RETIRED_OPERATION = "platform.user_retired";
export const USER_STATUS_OPERATION = "platform.user_status_changed";
export const MEMBERSHIP_GRANTED_OPERATION = "platform.membership_granted";
export const MEMBERSHIP_TRANSITIONED_OPERATION = "platform.membership_transitioned";

/**
 * The second row, when a change that was recorded then refused.
 *
 * ADR-0313's rule puts the record **before** the write and refuses a write it cannot record, which
 * is right and has one consequence worth answering rather than living with: a
 * `platform.membership_granted` row lands for a grant that went on to 422, so an audit reader sees
 * a grant that never happened. Observed on the first live run of these routes.
 *
 * One operation rather than a `*_refused` sibling per act, with the attempted operation in the
 * payload — so the failures are directly countable the way `platform.page_undelivered` is
 * (ADR-0325), without five new strings. Emitted **best effort**: a failure to record a refusal must
 * not become a 503, both because nothing was changed and because a prober must not learn from a
 * status code that the recorder is down (ADR-0313's rule for a denied backfill).
 */
export const REGISTRY_REFUSED_OPERATION = "platform.user_registry_refused";

export interface PlatformUserRoutesContext {
  readonly store: PostgresUserStore;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles permitted to administer the registry. Fail-closed: empty ⇒ nobody. */
  readonly adminRoles: ReadonlySet<string>;
  /**
   * Required, not optional.
   *
   * Every route here either **mints a principal** or **grants one a role inside a tenant**, which is
   * the privileged-write class ADR-0313 and ADR-0331 record before the write and refuse when they
   * cannot. `buildReadStateRoutes` refuses at construction for its one privileged grant; this whole
   * surface is that grant, so the refusal is unconditional rather than per route.
   */
  readonly audit: UserRegistryAuditor;
  /**
   * Which roles the tenant a membership is being granted into actually declares, or `null` wherever
   * this process cannot name that set.
   *
   * Required, not optional, following `audit` above it: an optional field can be forgotten with the
   * type still valid (ADR-0330's rule), and forgetting *this* one means the fence silently does
   * nothing on the two surfaces it exists to guard — the permissive direction, and indistinguishable
   * from a deployment whose roles all check out. The compiler asks instead.
   */
  readonly roleDirectory: MembershipRoleDirectory;
  readonly clock?: () => Date;
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function rolesOf(ctx: PlatformUserRoutesContext, principal: ResolvedPrincipal | null): string[] {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])];
}

function guard(
  ctx: PlatformUserRoutesContext,
  principal: ResolvedPrincipal | null,
): HandlerOutput | null {
  if (principal === null) return json(401, { error: "authentication_required" });
  if (!rolesOf(ctx, principal).some((r) => ctx.adminRoles.has(r))) {
    return json(403, { error: "forbidden", detail: "insufficient role" });
  }
  return null;
}

/**
 * Records the act, and a failure to record **refuses** it.
 *
 * Returned as a `HandlerOutput` rather than thrown so the caller decides the shape; 503 because an
 * unrecordable write is a transient inability to satisfy a standing rule, which is retryable, where
 * a 403 would be a claim about the caller (ADR-0334's 403-vs-503 distinction for the status gate).
 */
async function record(
  ctx: PlatformUserRoutesContext,
  event: Omit<UserRegistryAuditEvent, "at">,
): Promise<HandlerOutput | null> {
  const at = (ctx.clock ?? ((): Date => new Date()))().toISOString();
  try {
    await ctx.audit({ ...event, at });
    return null;
  } catch {
    return json(503, {
      error: "audit_unavailable",
      detail: "a registry change cannot be made while it cannot be recorded",
    });
  }
}

/**
 * Records that a change this handler had already recorded was then refused, and returns the refusal.
 *
 * Best effort by design — see `REGISTRY_REFUSED_OPERATION`. The pairing is what makes the trail
 * readable: the `granted` row says the change was authorised and attempted, this one says it did not
 * land, and a reader counting one against the other gets the refusal rate for free.
 */
async function recordRefusal(
  ctx: PlatformUserRoutesContext,
  attempted: Omit<UserRegistryAuditEvent, "at">,
  refusal: string,
  output: HandlerOutput,
): Promise<HandlerOutput> {
  const at = (ctx.clock ?? ((): Date => new Date()))().toISOString();
  try {
    await ctx.audit({
      ...attempted,
      operation: REGISTRY_REFUSED_OPERATION,
      detail: { ...attempted.detail, attempted: attempted.operation, refusal },
      at,
    });
  } catch {
    /* nothing was changed; a lost refusal row must not become a 503 */
  }
  return output;
}

function firstQueryValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  // `typeof` rather than `Array.isArray`, whose `arg is any[]` narrows this union in the **positive**
  // direction only: inside the `if` the value really is a `string[]`, and the `else` keeps the whole
  // union, because `readonly string[]` is not assignable to `any[]` and so is not subtracted. That
  // is why the cast this replaces sat in the `else` arm (ADR-0362). `typeof` narrows both arms.
  return typeof value === "string" ? value : value[0];
}

/**
 * The first value a caller actually supplied for a parameter, treating an empty one as absent.
 *
 * A form serialises an unset field as `?k=`, and ADR-0359's class is about a value the caller *did*
 * supply being dropped — so an empty value is the parameter not being named, and the refusals below
 * read a present, non-empty one. One rule for all four parameters rather than per-parameter
 * judgement, which is how `?cursor=` and `?limit=` would otherwise come to disagree about the same
 * character.
 */
function suppliedQueryValue(value: string | readonly string[] | undefined): string | undefined {
  const first = firstQueryValue(value);
  return first === undefined || first.length === 0 ? undefined : first;
}

function queryOf(input: Parameters<Handler>[0]): Record<string, string | string[]> {
  // `IncomingRequest.query` is defaulted by its schema, so the type says it is always present; an
  // adapter or a test double that assembled the request by hand may not have set it, and an empty
  // map is the honest reading of "this caller named no parameters".
  return input.request.query ?? {};
}

/**
 * The list parameters whose supplied value can be refused outright.
 *
 * Module-private, unlike every `*_STATUSES` vocabulary above: what a client branches on is the
 * `error` code, not the parameter name, so exporting this would be a declaration with no reader.
 */
const LIST_QUERY_REFUSALS = ["status", "cursor", "limit"] as const;
type ListQueryRefusal = (typeof LIST_QUERY_REFUSALS)[number];

/**
 * Why each refusable parameter is refused, a **total map** so a fourth is a compile error rather
 * than a 400 with no explanation (`UNSERVED_LIST_OUTPUTS`' shape).
 *
 * Each reason says what the parameter used to do instead, because that is the half a caller cannot
 * see: all three were *dropped*, and a dropped predicate is a 200 carrying the rows the parameter
 * asked to exclude.
 */
const LIST_QUERY_REFUSAL_OUTPUTS: Readonly<
  Record<ListQueryRefusal, { readonly error: string; readonly reason: string }>
> = {
  status: {
    error: "status_not_a_declared_value",
    reason:
      "not a value the column's CHECK admits, so the filter was previously dropped and the response" +
      " carried every row — including the ones this parameter asked to exclude",
  },
  cursor: {
    error: "cursor_unreadable",
    reason:
      "not a cursor this surface issued, so it previously decoded to offset 0 and the response was" +
      " page 1 under a 200 indistinguishable from the page that was asked for",
  },
  limit: {
    error: "limit_not_an_integer",
    reason:
      "not a decimal integer, so it previously fell to the default page size; a well-formed page" +
      ` size outside 1..${String(REGISTRY_LIST_MAX_LIMIT)} is clamped rather than refused`,
  },
};

interface ListQueryRefusalDetail {
  readonly parameter: ListQueryRefusal;
  readonly value: string;
  /** The whole admissible set where there is one to print, and `null` where the shape is the rule. */
  readonly admissible: readonly string[] | null;
}

function listQueryRefused(refusal: ListQueryRefusalDetail): HandlerOutput {
  const { error, reason } = LIST_QUERY_REFUSAL_OUTPUTS[refusal.parameter];
  const admissible =
    refusal.admissible === null ? "" : ` Admissible: ${refusal.admissible.join(", ")}.`;
  return json(400, {
    error,
    detail: `'?${refusal.parameter}=${refusal.value}' is ${reason}.${admissible}`,
    parameter: refusal.parameter,
  });
}

interface RegistryListParams<S extends string> {
  readonly status: S | undefined;
  readonly limit: number | undefined;
  readonly cursor: string | undefined;
}

type RegistryListParse<S extends string> =
  | { readonly ok: true; readonly query: RegistryListParams<S> }
  | { readonly ok: false; readonly refusal: ListQueryRefusalDetail };

/**
 * A decimal integer, optionally signed. A negative page size is in shape and out of range, so it
 * clamps to 1 rather than being refused — the split the parser's own doc comment states.
 */
const DECIMAL_INT_RE = /^[+-]?\d+$/;

/**
 * The three parameters both registry list handlers read, adjudicated once.
 *
 * One parser with the status vocabulary as its argument rather than one per handler: the two differ
 * in nothing else, and two copies is how both came to drop `?status=bogus` identically and in
 * silence.
 *
 * Refusals are returned in the order the parameters narrow the answer — the predicate, then the
 * position within it, then the page size — so a caller who got several wrong is told first about
 * the one that most changed what came back.
 *
 * An **unknown** parameter stays ignored. `?utm_source=ad` names nothing this surface declined to
 * serve, which is ADR-0359's own distinction between a parameter that was dropped and one that
 * never applied.
 *
 * The page size is decided on a different axis, and saying which one matters because ADR-0359's rule
 * does not reach it: that rule refuses a surface whose drop changes WHICH rows come back and reports
 * one whose drop changes only their ORDER, while a dropped `?limit` changes **how many** — neither
 * half. So the two parameters above are refused under the rule and this one is adjudicated on
 * malformed-versus-out-of-range. `?limit=abc` is malformed — the caller named a page size and
 * supplied something that is not one, which is a mistake they can act on — so it is refused.
 * `?limit=9999` is well formed and out of range, and `REGISTRY_LIST_MAX_LIMIT` is a platform decision
 * the caller does not get to overrule, so it clamps.
 */
function parseRegistryListQuery<S extends string>(
  query: Readonly<Record<string, string | readonly string[]>>,
  statuses: readonly S[],
): RegistryListParse<S> {
  const statusRaw = suppliedQueryValue(query["status"]);
  // `find` rather than `includes` plus a cast: the membership test and the narrowing are one step,
  // so no annotation stands in for the check (ADR-0362).
  const status = statusRaw === undefined ? undefined : statuses.find((s) => s === statusRaw);
  if (statusRaw !== undefined && status === undefined) {
    return { ok: false, refusal: { parameter: "status", value: statusRaw, admissible: statuses } };
  }
  const cursor = suppliedQueryValue(query["cursor"]);
  if (cursor !== undefined && !isUserListCursor(cursor)) {
    return { ok: false, refusal: { parameter: "cursor", value: cursor, admissible: null } };
  }
  const limitRaw = suppliedQueryValue(query["limit"]);
  if (limitRaw !== undefined && !DECIMAL_INT_RE.test(limitRaw)) {
    return { ok: false, refusal: { parameter: "limit", value: limitRaw, admissible: null } };
  }
  return {
    ok: true,
    query: {
      status,
      limit: limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10),
      cursor,
    },
  };
}

function buildListUsersHandler(ctx: PlatformUserRoutesContext): Handler {
  return async (input) => {
    const denial = guard(ctx, input.principal);
    if (denial !== null) return denial;
    const query = queryOf(input);
    const parsed = parseRegistryListQuery(query, USER_STATUSES);
    if (!parsed.ok) return listQueryRefused(parsed.refusal);
    const page = await ctx.store.list({
      ...parsed.query,
      // No refusal of its own: an `?email=` that is not an address names nothing this registry can
      // hold, and zero rows is the right answer to it rather than a mistake to report.
      email: suppliedQueryValue(query["email"]),
    });
    return json(200, { data: page.data, page: { nextCursor: page.nextCursor } });
  };
}

/**
 * The aggregate figures, which `counts()` has computed since it was written and nothing asked for.
 *
 * Not audited, and the two reads beside it are why: `platform.users.list` and `platform.users.get`
 * serve the registry unrecorded, and this serves strictly less of it — per-status totals over the
 * same rows. The rule that records a read in this repo is about reading the *trail*
 * (`--audit-read-routes`), where the subject of the read is every tenant's conduct.
 *
 * Its own route and deliberately **not** folded into `GET /v1/platform/stats`: that one mounts under
 * a different grant (`--platform-admin-role`) over `PostgresTenantStore`, so merging them would make
 * a user census require the tenant-administration grant.
 */
function buildUserStatsHandler(ctx: PlatformUserRoutesContext): Handler {
  return async ({ principal }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    return json(200, { counts: await ctx.store.counts() });
  };
}

const ProvisionBodySchema = z
  .object({
    user: CreateUserInputSchema,
    /**
     * Optional, and when present it carries its own `tenantId`. Not taken from the caller's
     * credential: a platform operator provisions *into* a tenant they are not a member of, so
     * reading the tenant off the principal would make the common case impossible.
     */
    membership: GrantMembershipInputSchema.omit({ userId: true }).optional(),
  })
  .strict();

function buildProvisionHandler(ctx: PlatformUserRoutesContext): Handler {
  return async ({ principal, parsedBody }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    const parsed = ProvisionBodySchema.safeParse(parsedBody ?? {});
    if (!parsed.success) {
      return json(400, { error: "invalid_request", detail: parsed.error.issues });
    }
    const { user, membership } = parsed.data;
    // After the body parses and before the record, because the warnings ride on the audit detail and
    // ADR-0313 puts the record before the write — a detail added afterwards would not be in the row.
    // `[]` and never an omitted field: an absent list reads as "none" and would be indistinguishable
    // from "not checked" (ADR-0331), and being told is the whole point of the fence. A body with no
    // membership grants no role, so the empty list is the claim rather than a gap.
    const roleWarnings: readonly MembershipRoleWarning[] =
      membership === undefined
        ? []
        : await checkMembershipRoles(
            {
              // The membership's own tenant, which is the body's and deliberately not the caller's
              // (see `ProvisionBodySchema`): the roles are adjudicated against the tenant the grant
              // lands in, and a platform operator provisions into tenants they do not belong to.
              tenantId: membership.tenantId,
              primaryRole: membership.primaryRole,
              secondaryRoles: membership.secondaryRoles,
            },
            ctx.roleDirectory,
          );
    const event: Omit<UserRegistryAuditEvent, "at"> = {
      operation: USER_PROVISIONED_OPERATION,
      tenantId: membership?.tenantId ?? null,
      // Null unless the body named the id: a server-minted one does not exist yet, and writing a
      // placeholder would make the record say the registry minted an id it did not.
      subjectUserId: user.id ?? null,
      principalId: principal?.principalId ?? null,
      roles: rolesOf(ctx, principal),
      detail: {
        email: normalizeEmail(user.email),
        idSupplied: user.id !== undefined,
        membership:
          membership === undefined
            ? null
            : {
                tenantId: membership.tenantId,
                primaryRole: membership.primaryRole,
                status: membership.status,
              },
        roleWarnings,
      },
    };
    const unrecordable = await record(ctx, event);
    if (unrecordable !== null) return unrecordable;
    try {
      const created = await ctx.store.provision(user, membership);
      return json(201, { user: created.user, membership: created.membership, roleWarnings });
    } catch (err) {
      if (err instanceof DuplicateUserError) {
        return recordRefusal(ctx, event, "user_exists", json(409, { error: "user_exists", detail: err.message }));
      }
      if (err instanceof DuplicateMembershipError) {
        return recordRefusal(
          ctx,
          event,
          "membership_exists",
          json(409, { error: "membership_exists", detail: err.message }),
        );
      }
      if (err instanceof UnknownPrincipalError) {
        return recordRefusal(
          ctx,
          event,
          "unknown_principal",
          json(422, { error: "unknown_principal", detail: err.message }),
        );
      }
      throw err;
    }
  };
}

function buildGetUserHandler(ctx: PlatformUserRoutesContext): Handler {
  return async ({ principal, params }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    const id = params["id"] ?? "";
    const user = await ctx.store.getById(id);
    if (user === null) return json(404, { error: "user_not_found", detail: id });
    return json(200, { user });
  };
}

/** Suspend / reactivate / retire, gated on `canTransitionUser` and then on the row itself. */
function buildUserTransitionHandler(
  ctx: PlatformUserRoutesContext,
  target: UserStatus,
  operation: string,
): Handler {
  return async ({ principal, params }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    const id = params["id"] ?? "";
    const current = await ctx.store.getById(id);
    if (current === null) return json(404, { error: "user_not_found", detail: id });
    if (!canTransitionUser(current.status, target)) {
      return json(409, { error: "illegal_transition", detail: `${current.status} -> ${target}` });
    }
    const event: Omit<UserRegistryAuditEvent, "at"> = {
      operation,
      tenantId: null,
      subjectUserId: id,
      principalId: principal?.principalId ?? null,
      roles: rolesOf(ctx, principal),
      detail: { from: current.status, to: target },
    };
    const unrecordable = await record(ctx, event);
    if (unrecordable !== null) return unrecordable;
    // The source set is the state just read, so a concurrent change loses the row rather than being
    // overwritten — and a no-match still leaves this response's claim true, because the only states
    // that could have replaced it are ones this transition is not legal from.
    const user = await ctx.store.transitionStatus(id, target, [current.status]);
    if (user === null) {
      return recordRefusal(
        ctx,
        event,
        "status_changed",
        json(409, {
          error: "status_changed",
          detail: `the user was no longer '${current.status}' when the change landed`,
        }),
      );
    }
    return json(200, { user });
  };
}

function buildListMembersHandler(ctx: PlatformUserRoutesContext): Handler {
  return async (input) => {
    const denial = guard(ctx, input.principal);
    if (denial !== null) return denial;
    const tenantId = input.params["tenantId"] ?? "";
    if (!z.string().uuid().safeParse(tenantId).success) {
      return json(400, { error: "invalid_request", detail: "tenantId must be a uuid" });
    }
    const parsed = parseRegistryListQuery(queryOf(input), MEMBERSHIP_STATUSES);
    if (!parsed.ok) return listQueryRefused(parsed.refusal);
    const page = await ctx.store.membershipsForTenant(tenantId, parsed.query);
    return json(200, { data: page.data, page: { nextCursor: page.nextCursor } });
  };
}

const GrantBodySchema = GrantMembershipInputSchema.omit({ tenantId: true }).strict();

function buildGrantMembershipHandler(ctx: PlatformUserRoutesContext): Handler {
  return async ({ principal, params, parsedBody }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    const tenantId = params["tenantId"] ?? "";
    if (!z.string().uuid().safeParse(tenantId).success) {
      return json(400, { error: "invalid_request", detail: "tenantId must be a uuid" });
    }
    const parsed = GrantBodySchema.safeParse(parsedBody ?? {});
    if (!parsed.success) {
      return json(400, { error: "invalid_request", detail: parsed.error.issues });
    }
    // The tenant is the path's, never the body's: two places naming it is two chances to disagree,
    // and the path is the one the grant's own scope predicate is built from.
    const input: GrantMembershipInput = { ...parsed.data, tenantId };
    // After the body parses and before the record, for the reason `buildProvisionHandler` states:
    // the warnings ride on the audit detail, so they have to exist by the time `record` runs. They
    // gate nothing — no status code and no control flow turns on them.
    const roleWarnings = await checkMembershipRoles(
      { tenantId, primaryRole: input.primaryRole, secondaryRoles: input.secondaryRoles },
      ctx.roleDirectory,
    );
    const event: Omit<UserRegistryAuditEvent, "at"> = {
      operation: MEMBERSHIP_GRANTED_OPERATION,
      tenantId,
      subjectUserId: input.userId,
      principalId: principal?.principalId ?? null,
      roles: rolesOf(ctx, principal),
      detail: {
        primaryRole: input.primaryRole,
        secondaryRoles: input.secondaryRoles,
        status: input.status,
        roleWarnings,
      },
    };
    const unrecordable = await record(ctx, event);
    if (unrecordable !== null) return unrecordable;
    try {
      const membership = await ctx.store.grantMembership(input);
      return json(201, { membership, roleWarnings });
    } catch (err) {
      if (err instanceof DuplicateMembershipError) {
        return recordRefusal(
          ctx,
          event,
          "membership_exists",
          json(409, { error: "membership_exists", detail: err.message }),
        );
      }
      if (err instanceof UnknownPrincipalError) {
        return recordRefusal(
          ctx,
          event,
          "unknown_principal",
          json(422, { error: "unknown_principal", detail: err.message }),
        );
      }
      throw err;
    }
  };
}

function buildMembershipTransitionHandler(
  ctx: PlatformUserRoutesContext,
  target: MembershipStatus,
): Handler {
  return async ({ principal, params }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    const tenantId = params["tenantId"] ?? "";
    const userId = params["userId"] ?? "";
    if (!z.string().uuid().safeParse(tenantId).success || !z.string().uuid().safeParse(userId).success) {
      return json(400, { error: "invalid_request", detail: "tenantId and userId must be uuids" });
    }
    const current = await ctx.store.membershipFor(tenantId, userId);
    if (current === null) return json(404, { error: "membership_not_found", detail: `${tenantId}/${userId}` });
    if (!canTransitionMembership(current.status, target)) {
      return json(409, { error: "illegal_transition", detail: `${current.status} -> ${target}` });
    }
    const event: Omit<UserRegistryAuditEvent, "at"> = {
      operation: MEMBERSHIP_TRANSITIONED_OPERATION,
      tenantId,
      subjectUserId: userId,
      principalId: principal?.principalId ?? null,
      roles: rolesOf(ctx, principal),
      detail: { from: current.status, to: target },
    };
    const unrecordable = await record(ctx, event);
    if (unrecordable !== null) return unrecordable;
    const membership = await ctx.store.transitionMembershipStatus(tenantId, userId, target, [
      current.status,
    ]);
    if (membership === null) {
      return recordRefusal(
        ctx,
        event,
        "status_changed",
        json(409, {
          error: "status_changed",
          detail: `the membership was no longer '${current.status}' when the change landed`,
        }),
      );
    }
    return json(200, { membership });
  };
}

/**
 * A single path segment shaped like a UUID.
 *
 * On `platform.users.get` this is load-bearing rather than defensive. `matchRoute` returns the
 * **first** route whose segments match and a parameter with `pattern: null` matches any single
 * segment, so without it `/v1/platform/users/stats` is swallowed by the id route and answered
 * `400 id must be a uuid`. The matcher is the thing that decides which route a path reaches, so the
 * matcher is the thing asked; placing `stats` ahead of `get` costs nothing and is done as well, but
 * ordering alone would leave the next literal sibling in the same trap.
 *
 * It admits the **same set** as `z.string().uuid()` rather than a looser one, which is measured and
 * not assumed: on the zod this app resolves (3.25.76) that check is a bare hex-and-dashes shape — it
 * pins neither the version nor the variant nibble, so `11111111-1111-1111-1111-111111111111` parses
 * — and over 20,000 random segments of this shape the two agreed every time. So the handler's own
 * parse is a redundant second reader here and not a narrower one, and claiming it refuses something
 * the matcher admitted would be a division of labour that does not exist. What the pattern therefore
 * buys is the matcher's answer rather than a handler's: a segment that is not id-shaped is a clean
 * `no_route` — there is no such route — instead of a 400 from inside a handler never meant for it.
 * `buildGetUserHandler`'s own 400 is unreachable through the matcher as a consequence, and stays as
 * the fence for a direct call.
 *
 * Should that check ever narrow, the pattern must narrow with it or the matcher would route a
 * segment to a handler that refuses it, which is the 400 this exists to stop.
 *
 * Not applied to `tenantId` or `userId`: neither has a literal sibling at its position, so there is
 * nothing for the matcher to separate and the handler's parse is the whole fence there.
 */
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

/**
 * The platform user-registry routes, to inject via the gateway's `extraRoutes` hook.
 *
 * Membership lives under `/v1/platform/tenants/{tenantId}/members` rather than under the user,
 * because the membership table is the tenant-scoped half and the scope predicate every statement
 * against it carries has to come from somewhere the route can see. There is deliberately **no**
 * "which tenants does this user belong to" route: that read has no scope to name, so it would be
 * owner-dependent by construction — correct as the table's owner and empty as a non-owner — which
 * is precisely the defect ADR-0333 swept out of fourteen store classes.
 */
export function buildPlatformUserRoutes(
  ctx: PlatformUserRoutesContext,
): readonly ExtraGatewayRoute[] {
  if (typeof ctx.audit !== "function") {
    throw new Error(
      "platform user routes require an auditor: every route here mints a principal or grants it a " +
        "role inside a tenant, and such a write must be recordable before it lands",
    );
  }
  const v = (
    op: string,
    method: RouteDefinition["method"],
    segs: ReadonlyArray<string | { param: string; pattern?: string }>,
    handler: Handler,
  ): ExtraGatewayRoute => ({ route: route(op, method, segs), handler });
  return [
    v("platform.users.list", "GET", ["v1", "platform", "users"], buildListUsersHandler(ctx)),
    v("platform.users.provision", "POST", ["v1", "platform", "users"], buildProvisionHandler(ctx)),
    // Ahead of `platform.users.get`, whose parameter would otherwise match `stats` — belt and
    // braces beside `UUID_SEGMENT_PATTERN`, which is what actually separates the two.
    v("platform.users.stats", "GET", ["v1", "platform", "users", "stats"], buildUserStatsHandler(ctx)),
    v(
      "platform.users.get",
      "GET",
      ["v1", "platform", "users", { param: "id", pattern: UUID_SEGMENT_PATTERN }],
      buildGetUserHandler(ctx),
    ),
    v(
      "platform.users.suspend",
      "POST",
      ["v1", "platform", "users", { param: "id" }, "suspend"],
      buildUserTransitionHandler(ctx, "suspended", USER_STATUS_OPERATION),
    ),
    v(
      "platform.users.reactivate",
      "POST",
      ["v1", "platform", "users", { param: "id" }, "reactivate"],
      buildUserTransitionHandler(ctx, "active", USER_STATUS_OPERATION),
    ),
    v(
      "platform.users.retire",
      "POST",
      ["v1", "platform", "users", { param: "id" }, "retire"],
      buildUserTransitionHandler(ctx, "deleted", USER_RETIRED_OPERATION),
    ),
    v(
      "platform.tenants.members.list",
      "GET",
      ["v1", "platform", "tenants", { param: "tenantId" }, "members"],
      buildListMembersHandler(ctx),
    ),
    v(
      "platform.tenants.members.grant",
      "POST",
      ["v1", "platform", "tenants", { param: "tenantId" }, "members"],
      buildGrantMembershipHandler(ctx),
    ),
    v(
      "platform.tenants.members.activate",
      "POST",
      ["v1", "platform", "tenants", { param: "tenantId" }, "members", { param: "userId" }, "activate"],
      buildMembershipTransitionHandler(ctx, "active"),
    ),
    v(
      "platform.tenants.members.revoke",
      "POST",
      ["v1", "platform", "tenants", { param: "tenantId" }, "members", { param: "userId" }, "revoke"],
      buildMembershipTransitionHandler(ctx, "revoked"),
    ),
  ];
}
