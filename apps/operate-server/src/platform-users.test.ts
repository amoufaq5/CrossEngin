import { matchRoute } from "@crossengin/api-gateway";
import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CreateUserInputSchema,
  DuplicateMembershipError,
  DuplicateUserError,
  GrantMembershipInputSchema,
  MEMBERSHIP_STATUSES,
  MEMBERSHIP_STATUS_TRANSITIONS,
  MembershipRecordSchema,
  PostgresUserStore,
  REGISTRY_LIST_MAX_LIMIT,
  REGISTRY_REFUSED_OPERATION,
  USER_STATUSES,
  USER_STATUS_TRANSITIONS,
  UnknownPrincipalError,
  UserRecordSchema,
  buildPlatformUserRoutes,
  canTransitionMembership,
  canTransitionUser,
  decodeUserListCursor,
  isUserListCursor,
  normalizeEmail,
  type UserRegistryAuditEvent,
} from "./platform-users.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const USER = "00000000-0000-4000-8000-0000000000aa";
const AT = "2026-09-01T12:00:00.000Z";

type Row = Record<string, unknown>;

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Records every statement and answers from `responses`, and **throws** on two things a pure recorder
 * would wave through (ADR-0333, ADR-0334):
 *
 *  - a mutating statement against `user_tenant_membership` that does not name `tenant_id`, because
 *    that table's only policy is tenant isolation and a table's owner bypasses it;
 *  - any statement against `users` that *does* name `tenant_id`, because that column does not exist
 *    there — which is ADR-0332's `default_value` defect, where a fake asserting SQL shape could not
 *    know a column was absent.
 *
 * The second direction is the one a generic `assertStatementIsScoped` cannot express, and it is the
 * reason this fake is local rather than borrowed.
 */
function fakeDb(responses: readonly Row[][]): {
  conn: PgConnection;
  captured: Captured[];
  tenantContext: () => string | null;
  sql: () => string;
} {
  const captured: Captured[] = [];
  let tenant: string | null = null;
  let next = 0;

  const run = async (
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }> => {
    const p = params ?? [];
    captured.push({ sql, params: p });
    if (sql.includes("set_config")) {
      tenant = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    const mutating = /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql);
    if (/user_tenant_membership/.test(sql) && mutating && !/tenant_id/.test(sql)) {
      throw new Error(
        "this fake refuses an unscoped membership write: user_tenant_membership carries one " +
          `ALL-scope isolation policy and its owner bypasses it — got: ${sql.slice(0, 120)}`,
      );
    }
    if (/\busers\b/.test(sql) && !/user_tenant_membership/.test(sql) && /tenant_id/.test(sql)) {
      throw new Error(
        `this fake refuses a tenant_id predicate on meta.users: the column does not exist — got: ${sql.slice(0, 120)}`,
      );
    }
    const rows = responses[next] ?? [];
    next += 1;
    return { rows: [...rows], rowCount: rows.length };
  };

  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => fn(conn),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async (): Promise<void> => undefined,
  };

  return {
    conn,
    captured,
    tenantContext: () => tenant,
    sql: () => captured.map((c) => c.sql).join("\n---\n"),
  };
}

function userRow(over: Row = {}): Row {
  return {
    id: USER,
    email: "ada@example.com",
    display_name: "Ada",
    phone_e164: "+15550001111",
    status: "active",
    created_at: AT,
    updated_at: AT,
    last_login_at: null,
    ...over,
  };
}

function membershipRow(over: Row = {}): Row {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    user_id: USER,
    tenant_id: TENANT,
    primary_role: "erp_admin",
    secondary_roles: ["auditor"],
    status: "active",
    abac_attributes: { dept: "fin" },
    created_at: AT,
    updated_at: AT,
    ...over,
  };
}

function pgError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`pg ${code}`), { code, ...extra });
}

describe("contracts", () => {
  it("declares the three statuses the CHECK admits, and nothing else", () => {
    expect(USER_STATUSES).toEqual(["active", "suspended", "deleted"]);
    expect(MEMBERSHIP_STATUSES).toEqual(["active", "invited", "revoked"]);
  });

  it("makes `deleted` terminal and every other status reachable", () => {
    expect(USER_STATUS_TRANSITIONS.deleted).toEqual([]);
    expect(canTransitionUser("active", "deleted")).toBe(true);
    expect(canTransitionUser("suspended", "active")).toBe(true);
    expect(canTransitionUser("deleted", "active")).toBe(false);
  });

  it("lets a membership be restored but not re-invited", () => {
    expect(canTransitionMembership("revoked", "active")).toBe(true);
    expect(canTransitionMembership("active", "invited")).toBe(false);
    expect(canTransitionMembership("invited", "revoked")).toBe(true);
    // Every status is a key, so a fourth cannot inherit a loop's last answer.
    for (const s of MEMBERSHIP_STATUSES) {
      expect(MEMBERSHIP_STATUS_TRANSITIONS[s]).toBeDefined();
    }
  });

  it("folds an email to lower case and leaves subaddressing alone", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
    expect(normalizeEmail("ada+tag@example.com")).toBe("ada+tag@example.com");
  });

  it("refuses a phone that the column's CHECK would refuse", () => {
    expect(CreateUserInputSchema.safeParse({ email: "a@b.co", phoneE164: "5550001111" }).success).toBe(false);
    expect(CreateUserInputSchema.safeParse({ email: "a@b.co", phoneE164: "+05550001111" }).success).toBe(false);
    expect(CreateUserInputSchema.safeParse({ email: "a@b.co", phoneE164: "+15550001111" }).success).toBe(true);
  });

  it("accepts a caller-supplied id, which is the whole point", () => {
    expect(CreateUserInputSchema.safeParse({ id: USER, email: "a@b.co" }).success).toBe(true);
    expect(CreateUserInputSchema.safeParse({ id: "not-a-uuid", email: "a@b.co" }).success).toBe(false);
  });

  it("requires a membership status rather than defaulting one", () => {
    const body = { userId: USER, tenantId: TENANT, primaryRole: "erp_admin" };
    expect(GrantMembershipInputSchema.safeParse(body).success).toBe(false);
    expect(GrantMembershipInputSchema.safeParse({ ...body, status: "invited" }).success).toBe(true);
  });

  it("refuses an unknown key on either record schema", () => {
    expect(
      UserRecordSchema.safeParse({
        id: USER,
        email: "a@b.co",
        displayName: null,
        phoneE164: null,
        status: "active",
        createdAt: AT,
        updatedAt: AT,
        lastLoginAt: null,
        tenantId: TENANT,
      }).success,
    ).toBe(false);
    expect(MembershipRecordSchema.safeParse({}).success).toBe(false);
  });
});

describe("PostgresUserStore — users", () => {
  it("refuses an invalid schema identifier", () => {
    const { conn } = fakeDb([]);
    expect(() => new PostgresUserStore(conn, { schema: "me ta" })).toThrow(/invalid schema/);
  });

  it("inserts without an id when none is supplied, letting the column default mint one", async () => {
    const db = fakeDb([[userRow()]]);
    const store = new PostgresUserStore(db.conn);
    const result = await store.provision({ email: "Ada@Example.com" });
    expect(result.user.email).toBe("ada@example.com");
    expect(result.membership).toBeNull();
    const insert = db.captured[0];
    expect(insert?.sql).toMatch(/INSERT INTO meta\.users \(email, display_name, phone_e164, status\)/);
    expect(insert?.params).toEqual(["ada@example.com", null, null]);
  });

  it("binds a supplied id as the first extra parameter and casts it", async () => {
    const db = fakeDb([[userRow()]]);
    const store = new PostgresUserStore(db.conn);
    await store.provision({ id: USER, email: "ada@example.com", displayName: "Ada" });
    const insert = db.captured[0];
    expect(insert?.sql).toMatch(/\(id, email, display_name, phone_e164, status\)/);
    expect(insert?.sql).toMatch(/VALUES \(\$4::uuid, \$1, \$2, \$3, 'active'\)/);
    expect(insert?.params).toEqual(["ada@example.com", "Ada", null, USER]);
  });

  it("never names tenant_id on a users statement — the fake refuses it", async () => {
    const db = fakeDb([[userRow()]]);
    const store = new PostgresUserStore(db.conn);
    await store.provision({ email: "ada@example.com" });
    expect(db.sql()).not.toMatch(/tenant_id/);
  });

  it("writes the user and the membership in one transaction under tenant context", async () => {
    const db = fakeDb([[userRow()], [membershipRow()]]);
    const store = new PostgresUserStore(db.conn);
    const result = await store.provision(
      { id: USER, email: "ada@example.com" },
      { tenantId: TENANT, primaryRole: "erp_admin", secondaryRoles: [], abacAttributes: {}, status: "active" },
    );
    expect(result.membership?.tenantId).toBe(TENANT);
    expect(db.tenantContext()).toBe(TENANT);
    // set_config first, then both writes.
    expect(db.captured[0]?.sql).toMatch(/set_config/);
    expect(db.captured[1]?.sql).toMatch(/INSERT INTO meta\.users/);
    expect(db.captured[2]?.sql).toMatch(/INSERT INTO meta\.user_tenant_membership/);
  });

  it("maps a unique violation to DuplicateUserError", async () => {
    const db = fakeDb([]);
    const conn = { ...db.conn, transaction: async () => Promise.reject(pgError("23505")) };
    const store = new PostgresUserStore(conn as unknown as PgConnection);
    await expect(store.provision({ email: "ada@example.com" })).rejects.toBeInstanceOf(DuplicateUserError);
  });

  it("maps a users foreign-key violation on the membership half to UnknownPrincipalError", async () => {
    const db = fakeDb([]);
    const conn = {
      ...db.conn,
      transaction: async () =>
        Promise.reject(pgError("23503", { detail: 'Key is not present in table "users".' })),
    };
    const store = new PostgresUserStore(conn as unknown as PgConnection);
    await expect(
      store.provision(
        { email: "a@b.co" },
        { tenantId: TENANT, primaryRole: "r", secondaryRoles: [], abacAttributes: {}, status: "active" },
      ),
    ).rejects.toThrow(/meta\.users/);
  });

  it("distinguishes an absent tenant from an absent user in the refusal text", async () => {
    const db = fakeDb([]);
    const conn = {
      ...db.conn,
      transaction: async () =>
        Promise.reject(pgError("23503", { detail: 'Key is not present in table "tenants".' })),
    };
    const store = new PostgresUserStore(conn as unknown as PgConnection);
    await expect(
      store.provision(
        { email: "a@b.co" },
        { tenantId: TENANT, primaryRole: "r", secondaryRoles: [], abacAttributes: {}, status: "active" },
      ),
    ).rejects.toThrow(/meta\.tenants/);
  });

  it("normalises an email on lookup, so a mixed-case query finds the stored row", async () => {
    const db = fakeDb([[userRow()]]);
    const store = new PostgresUserStore(db.conn);
    await store.getByEmail("ADA@Example.com");
    expect(db.captured[0]?.params).toEqual(["ada@example.com"]);
  });

  it("re-parses a row and raises on one the contract forbids", async () => {
    const db = fakeDb([[userRow({ email: "not-an-address" })]]);
    const store = new PostgresUserStore(db.conn);
    await expect(store.getById(USER)).rejects.toThrow();
  });

  it("raises on a row whose NOT NULL timestamp came back null", async () => {
    const db = fakeDb([[userRow({ created_at: null })]]);
    const store = new PostgresUserStore(db.conn);
    await expect(store.getById(USER)).rejects.toThrow(/created_at/);
  });

  it("accepts a Date for a timestamp column, which is what node-postgres returns", async () => {
    const db = fakeDb([[userRow({ created_at: new Date(AT), updated_at: new Date(AT) })]]);
    const store = new PostgresUserStore(db.conn);
    const user = await store.getById(USER);
    expect(user?.createdAt).toBe(AT);
  });

  it("returns null for an absent user rather than raising", async () => {
    const db = fakeDb([[]]);
    const store = new PostgresUserStore(db.conn);
    expect(await store.getById(USER)).toBeNull();
  });

  it("pages with an opaque cursor and over-reads by one to decide hasMore", async () => {
    const db = fakeDb([[userRow({ id: USER }), userRow({ id: OTHER_TENANT })]]);
    const store = new PostgresUserStore(db.conn);
    const page = await store.list({ limit: 1, status: "active" });
    expect(page.data).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    expect(db.captured[0]?.params).toEqual(["active", 2, 0]);
  });

  it("re-asserts the source status inside the UPDATE predicate", async () => {
    const db = fakeDb([[userRow({ status: "suspended" })]]);
    const store = new PostgresUserStore(db.conn);
    await store.transitionStatus(USER, "suspended", ["active"]);
    expect(db.captured[0]?.sql).toMatch(/WHERE id = \$1 AND status IN \(\$3\)/);
    expect(db.captured[0]?.params).toEqual([USER, "suspended", "active"]);
  });

  it("refuses to issue an UPDATE with an empty source set", async () => {
    const db = fakeDb([[userRow()]]);
    const store = new PostgresUserStore(db.conn);
    expect(await store.transitionStatus(USER, "active", [])).toBeNull();
    expect(db.captured).toHaveLength(0);
  });

  it("counts every declared status as zero and still totals an undeclared one", async () => {
    const db = fakeDb([[{ status: "active", count: 2 }, { status: "quarantined", count: 1 }]]);
    const store = new PostgresUserStore(db.conn);
    const counts = await store.counts();
    expect(counts.active).toBe(2);
    expect(counts.suspended).toBe(0);
    expect(counts.total).toBe(3);
  });
});

describe("PostgresUserStore — memberships", () => {
  it("carries the strict scope predicate beside the tenant context on a read", async () => {
    const db = fakeDb([[membershipRow()]]);
    const store = new PostgresUserStore(db.conn);
    await store.membershipFor(TENANT, USER);
    const read = db.captured[1];
    expect(read?.sql).toMatch(/WHERE tenant_id = \$1 AND user_id = \$2::uuid/);
    expect(read?.params).toEqual([TENANT, USER]);
    expect(db.tenantContext()).toBe(TENANT);
  });

  it("uses the strict spelling and never the platform-inclusive one", async () => {
    const db = fakeDb([[membershipRow()]]);
    const store = new PostgresUserStore(db.conn);
    await store.membershipsForTenant(TENANT, { status: "active", limit: 10 });
    // `tenant_id` is NOT NULL on this table, so a platform arm could only widen past what a
    // non-owner is shown.
    expect(db.sql()).not.toMatch(/tenant_id IS NULL/);
    expect(db.captured[1]?.params).toEqual([TENANT, "active", 11, 0]);
  });

  it("names tenant_id on the membership INSERT, which the fake requires", async () => {
    const db = fakeDb([[membershipRow()]]);
    const store = new PostgresUserStore(db.conn);
    const granted = await store.grantMembership({
      userId: USER,
      tenantId: TENANT,
      primaryRole: "erp_admin",
      secondaryRoles: ["auditor"],
      abacAttributes: { dept: "fin" },
      status: "active",
    });
    expect(granted.secondaryRoles).toEqual(["auditor"]);
    expect(db.captured[1]?.sql).toMatch(/INSERT INTO meta\.user_tenant_membership/);
    expect(db.captured[1]?.params[1]).toBe(TENANT);
    expect(db.captured[1]?.params[3]).toEqual(["auditor"]);
    expect(db.captured[1]?.params[5]).toBe('{"dept":"fin"}');
  });

  it("maps the membership unique constraint to DuplicateMembershipError", async () => {
    const db = fakeDb([]);
    const conn = { ...db.conn, transaction: async () => Promise.reject(pgError("23505")) };
    const store = new PostgresUserStore(conn as unknown as PgConnection);
    await expect(
      store.grantMembership({
        userId: USER,
        tenantId: TENANT,
        primaryRole: "r",
        secondaryRoles: [],
        abacAttributes: {},
        status: "active",
      }),
    ).rejects.toBeInstanceOf(DuplicateMembershipError);
  });

  it("maps a 23503 on grant to UnknownPrincipalError naming both ids", async () => {
    const db = fakeDb([]);
    const conn = {
      ...db.conn,
      transaction: async () =>
        Promise.reject(pgError("23503", { constraint: "user_tenant_membership_user_id_fkey" })),
    };
    const store = new PostgresUserStore(conn as unknown as PgConnection);
    await expect(
      store.grantMembership({
        userId: USER,
        tenantId: TENANT,
        primaryRole: "r",
        secondaryRoles: [],
        abacAttributes: {},
        status: "active",
      }),
    ).rejects.toBeInstanceOf(UnknownPrincipalError);
  });

  it("guards a membership transition on both the scope and the source status", async () => {
    const db = fakeDb([[membershipRow({ status: "revoked" })]]);
    const store = new PostgresUserStore(db.conn);
    await store.transitionMembershipStatus(TENANT, USER, "revoked", ["active", "invited"]);
    const update = db.captured[1];
    expect(update?.sql).toMatch(
      /UPDATE meta\.user_tenant_membership SET status = \$3, updated_at = now\(\) WHERE tenant_id = \$1 AND user_id = \$2::uuid AND status IN \(\$4, \$5\)/,
    );
    expect(update?.params).toEqual([TENANT, USER, "revoked", "active", "invited"]);
  });

  it("parses a JSONB column that came back as text", async () => {
    const db = fakeDb([[membershipRow({ abac_attributes: '{"a":1}' })]]);
    const store = new PostgresUserStore(db.conn);
    const m = await store.membershipFor(TENANT, USER);
    expect(m?.abacAttributes).toEqual({ a: 1 });
  });

  it("degrades an unreadable JSONB column to an empty object rather than raising", async () => {
    const db = fakeDb([[membershipRow({ abac_attributes: "not json" })]]);
    const store = new PostgresUserStore(db.conn);
    const m = await store.membershipFor(TENANT, USER);
    expect(m?.abacAttributes).toEqual({});
  });
});

/* ------------------------------------------------------------------- routes */

interface Recorded {
  readonly events: UserRegistryAuditEvent[];
}

/** The roles the default fake directory says the tenant declares — the ones `membershipRow` uses. */
const DECLARED_ROLES = ["auditor", "erp_admin"] as const;

function ctxFor(
  store: PostgresUserStore,
  opts: {
    readonly roles?: readonly string[];
    readonly auditThrows?: boolean;
    /** What the role directory answers; `null` is "this process cannot say which roles exist". */
    readonly declaredRoles?: readonly string[] | null;
    readonly directoryThrows?: boolean;
  } = {},
): {
  ctx: Parameters<typeof buildPlatformUserRoutes>[0];
  recorded: Recorded;
  directoryCalls: () => number;
  /**
   * The tenant ids the directory was asked about, in order.
   *
   * Recorded rather than discarded because the argument is the whole of which role catalog the
   * grant is adjudicated against: `node.ts`'s directory reads it (`activeManifestFor(tenantId)`), so
   * under per-tenant manifests a wrong tenant answers with a different tenant's roles. A fake that
   * ignores its parameter leaves that decision unfenced — handing either path the user id in place
   * of the tenant passed every test in this file.
   */
  directoryAsked: () => readonly string[];
} {
  const recorded: Recorded = { events: [] };
  let directoryCalls = 0;
  const asked: string[] = [];
  return {
    recorded,
    directoryCalls: () => directoryCalls,
    directoryAsked: () => asked,
    ctx: {
      store,
      principalRoles: () => ({ primaryRole: (opts.roles ?? ["platform_admin"])[0] ?? "anonymous" }),
      adminRoles: new Set(["platform_admin"]),
      roleDirectory: async (tenantId) => {
        directoryCalls += 1;
        asked.push(tenantId);
        if (opts.directoryThrows === true) throw new Error("manifest store unreachable");
        const declared = opts.declaredRoles === undefined ? DECLARED_ROLES : opts.declaredRoles;
        return declared === null ? null : new Set(declared);
      },
      audit: async (e) => {
        if (opts.auditThrows === true) throw new Error("audit down");
        recorded.events.push(e);
      },
      clock: () => new Date(AT),
    },
    };
}

/**
 * The `roleWarnings` a response or an audit detail carries, **parsed** rather than asserted.
 *
 * `.strict()` over the whole warning, so a body carrying a summary instead of the fence's own
 * records — or an extra key — fails here rather than reading as a clean check.
 */
const RoleWarningsShape = z.array(
  z
    .object({
      position: z.enum(["primary", "secondary"]),
      role: z.string().min(1),
      verdict: z.enum(["not_declared", "unresolved"]),
      detail: z.string().min(1),
      declaredRoles: z.array(z.string()).nullable(),
    })
    .strict(),
);

function warningsOf(carrier: unknown): z.infer<typeof RoleWarningsShape> {
  const parsed = z.object({ roleWarnings: RoleWarningsShape }).safeParse(carrier);
  if (!parsed.success) throw new Error(`no roleWarnings: ${parsed.error.message}`);
  return parsed.data.roleWarnings;
}

function principal(): { readonly principalId: string } {
  return { principalId: "99999999-9999-4999-8999-999999999999" };
}

function handlerFor(
  routes: readonly { route: { operationId: string }; handler: unknown }[],
  operationId: string,
): (input: Record<string, unknown>) => Promise<{ status: number; body: unknown }> {
  const found = routes.find((r) => r.route.operationId === operationId);
  if (found === undefined) throw new Error(`no route ${operationId}`);
  return found.handler as (input: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
}

describe("buildPlatformUserRoutes", () => {
  it("refuses to construct without an auditor", () => {
    const { conn } = fakeDb([]);
    const store = new PostgresUserStore(conn);
    expect(() =>
      buildPlatformUserRoutes({
        store,
        principalRoles: () => ({ primaryRole: "platform_admin" }),
        adminRoles: new Set(["platform_admin"]),
        roleDirectory: async () => null,
        audit: undefined as unknown as (e: UserRegistryAuditEvent) => Promise<void>,
      }),
    ).toThrow(/require an auditor/);
  });

  it("exposes eleven routes and no duplicate operation id", () => {
    const { conn } = fakeDb([]);
    const { ctx } = ctxFor(new PostgresUserStore(conn));
    const routes = buildPlatformUserRoutes(ctx);
    expect(routes).toHaveLength(11);
    expect(new Set(routes.map((r) => r.route.operationId)).size).toBe(11);
  });

  it("401s with no principal and 403s with the wrong role", async () => {
    const { conn } = fakeDb([[], []]);
    const { ctx } = ctxFor(new PostgresUserStore(conn), { roles: ["erp_admin"] });
    const list = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.list");
    expect((await list({ principal: null, params: {}, request: {} })).status).toBe(401);
    expect((await list({ principal: principal(), params: {}, request: {} })).status).toBe(403);
  });

  it("records the provision before the write and 201s", async () => {
    const db = fakeDb([[userRow()]]);
    const { ctx, recorded } = ctxFor(new PostgresUserStore(db.conn));
    const provision = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.provision");
    const out = await provision({
      principal: principal(),
      params: {},
      request: {},
      parsedBody: { user: { id: USER, email: "Ada@Example.com" } },
    });
    expect(out.status).toBe(201);
    expect(recorded.events[0]?.operation).toBe("platform.user_provisioned");
    expect(recorded.events[0]?.detail["email"]).toBe("ada@example.com");
    expect(recorded.events[0]?.subjectUserId).toBe(USER);
  });

  it("reports no subject when the body named no id, rather than a placeholder", async () => {
    const db = fakeDb([[userRow()]]);
    const { ctx, recorded } = ctxFor(new PostgresUserStore(db.conn));
    const provision = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.provision");
    await provision({
      principal: principal(),
      params: {},
      request: {},
      parsedBody: { user: { email: "ada@example.com" } },
    });
    expect(recorded.events[0]?.subjectUserId).toBeNull();
    expect(recorded.events[0]?.detail["idSupplied"]).toBe(false);
  });

  it("503s and writes nothing when the act cannot be recorded", async () => {
    const db = fakeDb([[userRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn), { auditThrows: true });
    const provision = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.provision");
    const out = await provision({
      principal: principal(),
      params: {},
      request: {},
      parsedBody: { user: { email: "ada@example.com" } },
    });
    expect(out.status).toBe(503);
    expect((out.body as { error: string }).error).toBe("audit_unavailable");
    expect(db.captured).toHaveLength(0);
  });

  it("400s on a body with an unknown key", async () => {
    const db = fakeDb([]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const provision = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.provision");
    const out = await provision({
      principal: principal(),
      params: {},
      request: {},
      parsedBody: { user: { email: "a@b.co" }, extra: 1 },
    });
    expect(out.status).toBe(400);
  });

  it("409s on a duplicate email and 422s on a membership naming an absent party", async () => {
    const dup = fakeDb([]);
    const dupConn = { ...dup.conn, transaction: async () => Promise.reject(pgError("23505")) };
    const { ctx: dupCtx } = ctxFor(new PostgresUserStore(dupConn as unknown as PgConnection));
    const provisionDup = handlerFor(buildPlatformUserRoutes(dupCtx), "platform.users.provision");
    const dupOut = await provisionDup({
      principal: principal(),
      params: {},
      request: {},
      parsedBody: { user: { email: "a@b.co" } },
    });
    expect(dupOut.status).toBe(409);

    const fk = fakeDb([]);
    const fkConn = {
      ...fk.conn,
      transaction: async () =>
        Promise.reject(pgError("23503", { detail: 'Key is not present in table "tenants".' })),
    };
    const { ctx: fkCtx } = ctxFor(new PostgresUserStore(fkConn as unknown as PgConnection));
    const grant = handlerFor(buildPlatformUserRoutes(fkCtx), "platform.tenants.members.grant");
    const fkOut = await grant({
      principal: principal(),
      params: { tenantId: TENANT },
      request: {},
      parsedBody: { userId: USER, primaryRole: "r", status: "active" },
    });
    expect(fkOut.status).toBe(422);
    expect((fkOut.body as { error: string }).error).toBe("unknown_principal");
  });

  it("refuses an illegal user transition with a 409 before touching the row", async () => {
    const db = fakeDb([[userRow({ status: "deleted" })]]);
    const { ctx, recorded } = ctxFor(new PostgresUserStore(db.conn));
    const retire = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.retire");
    const out = await retire({ principal: principal(), params: { id: USER }, request: {} });
    expect(out.status).toBe(409);
    expect((out.body as { error: string }).error).toBe("illegal_transition");
    expect(recorded.events).toHaveLength(0);
  });

  it("409s `status_changed` when the guarded UPDATE matched no row", async () => {
    const db = fakeDb([[userRow({ status: "active" })], []]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const suspend = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.suspend");
    const out = await suspend({ principal: principal(), params: { id: USER }, request: {} });
    expect(out.status).toBe(409);
    expect((out.body as { error: string }).error).toBe("status_changed");
  });

  it("takes the membership tenant from the path and refuses a non-uuid segment", async () => {
    const db = fakeDb([[membershipRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const routes = buildPlatformUserRoutes(ctx);
    const bad = await handlerFor(routes, "platform.tenants.members.list")({
      principal: principal(),
      params: { tenantId: "nope" },
      request: {},
    });
    expect(bad.status).toBe(400);

    const grant = handlerFor(routes, "platform.tenants.members.grant");
    const out = await grant({
      principal: principal(),
      params: { tenantId: TENANT },
      request: {},
      parsedBody: { userId: USER, primaryRole: "erp_admin", status: "active" },
    });
    expect(out.status).toBe(201);
    expect(db.captured.find((c) => c.sql.includes("INSERT"))?.params[1]).toBe(TENANT);
  });

  it("refuses a grant body that tries to name its own tenant", async () => {
    const db = fakeDb([]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const grant = handlerFor(buildPlatformUserRoutes(ctx), "platform.tenants.members.grant");
    const out = await grant({
      principal: principal(),
      params: { tenantId: TENANT },
      request: {},
      parsedBody: { userId: USER, primaryRole: "r", status: "active", tenantId: OTHER_TENANT },
    });
    expect(out.status).toBe(400);
  });

  it("404s a membership transition for a pair with no row", async () => {
    const db = fakeDb([[]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const revoke = handlerFor(buildPlatformUserRoutes(ctx), "platform.tenants.members.revoke");
    const out = await revoke({
      principal: principal(),
      params: { tenantId: TENANT, userId: USER },
      request: {},
    });
    expect(out.status).toBe(404);
  });

  it("records a membership transition with the tenant it is about", async () => {
    const db = fakeDb([[membershipRow({ status: "active" })], [membershipRow({ status: "revoked" })]]);
    const { ctx, recorded } = ctxFor(new PostgresUserStore(db.conn));
    const revoke = handlerFor(buildPlatformUserRoutes(ctx), "platform.tenants.members.revoke");
    const out = await revoke({
      principal: principal(),
      params: { tenantId: TENANT, userId: USER },
      request: {},
    });
    expect(out.status).toBe(200);
    expect(recorded.events[0]?.tenantId).toBe(TENANT);
    expect(recorded.events[0]?.detail).toEqual({ from: "active", to: "revoked" });
  });

  it("404s a user that does not exist", async () => {
    const db = fakeDb([[]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const get = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.get");
    const out = await get({ principal: principal(), params: { id: USER }, request: {} });
    expect(out.status).toBe(404);
  });

  it("pairs the recorded change with a refusal row when the write did not land", async () => {
    const db = fakeDb([]);
    const conn = { ...db.conn, transaction: async () => Promise.reject(pgError("23505")) };
    const { ctx, recorded } = ctxFor(new PostgresUserStore(conn as unknown as PgConnection));
    const provision = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.provision");
    const out = await provision({
      principal: principal(),
      params: {},
      request: {},
      parsedBody: { user: { email: "a@b.co" } },
    });
    expect(out.status).toBe(409);
    // Two rows: ADR-0313's rule puts the record before the write, so without the second a reader
    // sees a provision that never happened.
    expect(recorded.events.map((e) => e.operation)).toEqual([
      "platform.user_provisioned",
      REGISTRY_REFUSED_OPERATION,
    ]);
    expect(recorded.events[1]?.detail["attempted"]).toBe("platform.user_provisioned");
    expect(recorded.events[1]?.detail["refusal"]).toBe("user_exists");
  });

  it("records a refusal for a lost transition race and carries the attempted operation", async () => {
    const db = fakeDb([[userRow({ status: "active" })], []]);
    const { ctx, recorded } = ctxFor(new PostgresUserStore(db.conn));
    const retire = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.retire");
    const out = await retire({ principal: principal(), params: { id: USER }, request: {} });
    expect(out.status).toBe(409);
    expect(recorded.events.map((e) => e.operation)).toEqual([
      "platform.user_retired",
      REGISTRY_REFUSED_OPERATION,
    ]);
    expect(recorded.events[1]?.detail["refusal"]).toBe("status_changed");
  });

  it("records a refusal for a membership grant that names nobody", async () => {
    const db = fakeDb([]);
    const conn = {
      ...db.conn,
      transaction: async () =>
        Promise.reject(pgError("23503", { detail: 'Key is not present in table "users".' })),
    };
    const { ctx, recorded } = ctxFor(new PostgresUserStore(conn as unknown as PgConnection));
    const grant = handlerFor(buildPlatformUserRoutes(ctx), "platform.tenants.members.grant");
    await grant({
      principal: principal(),
      params: { tenantId: TENANT },
      request: {},
      parsedBody: { userId: USER, primaryRole: "r", status: "active" },
    });
    expect(recorded.events[1]?.operation).toBe(REGISTRY_REFUSED_OPERATION);
    expect(recorded.events[1]?.detail["attempted"]).toBe("platform.membership_granted");
    expect(recorded.events[1]?.tenantId).toBe(TENANT);
  });

  it("still returns the refusal when the refusal itself cannot be recorded", async () => {
    // Best effort, deliberately: nothing was changed, so a lost refusal row must not become a 503 —
    // and a prober must not learn from a status code that the recorder is down.
    const db = fakeDb([]);
    const conn = { ...db.conn, transaction: async () => Promise.reject(pgError("23505")) };
    let calls = 0;
    const out = await handlerFor(
      buildPlatformUserRoutes({
        store: new PostgresUserStore(conn as unknown as PgConnection),
        principalRoles: () => ({ primaryRole: "platform_admin" }),
        adminRoles: new Set(["platform_admin"]),
        roleDirectory: async () => new Set(DECLARED_ROLES),
        audit: async () => {
          calls += 1;
          if (calls > 1) throw new Error("audit down");
        },
      }),
      "platform.users.provision",
    )({ principal: principal(), params: {}, request: {}, parsedBody: { user: { email: "a@b.co" } } });
    expect(out.status).toBe(409);
    expect(calls).toBe(2);
  });

  it("records nothing at all when the body never parsed", async () => {
    const db = fakeDb([]);
    const { ctx, recorded } = ctxFor(new PostgresUserStore(db.conn));
    const provision = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.provision");
    await provision({
      principal: principal(),
      params: {},
      request: {},
      parsedBody: { user: { email: "nope" } },
    });
    // Nothing was authorised, so there is nothing to account for — the pairing starts at the point
    // a change is admitted.
    expect(recorded.events).toHaveLength(0);
  });

  it("has no route that lists a user's tenants, deliberately", () => {
    const db = fakeDb([]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const ops = buildPlatformUserRoutes(ctx).map((r) => r.route.operationId);
    // Such a read has no scope to name, so it would be owner-dependent by construction — correct as
    // the table's owner and empty as a non-owner (ADR-0333).
    expect(ops.some((op) => /users\..*tenants|memberships/.test(op))).toBe(false);
  });
});

/* ------------------------------------------------------- the role fence, wired */

describe("the membership role fence on both write paths", () => {
  it("warns on the grant path and carries the warning in the 201 body", async () => {
    const db = fakeDb([[membershipRow({ primary_role: "ghost_role" })]]);
    const { ctx, directoryAsked } = ctxFor(new PostgresUserStore(db.conn));
    const grant = handlerFor(buildPlatformUserRoutes(ctx), "platform.tenants.members.grant");
    const out = await grant({
      principal: principal(),
      params: { tenantId: TENANT },
      request: {},
      parsedBody: { userId: USER, primaryRole: "ghost_role", status: "active" },
    });
    expect(out.status).toBe(201);
    const warnings = warningsOf(out.body);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.role).toBe("ghost_role");
    expect(warnings[0]?.verdict).toBe("not_declared");
    expect(warnings[0]?.position).toBe("primary");
    // The path's tenant and nothing else: the body does not carry one here (`GrantBodySchema` omits
    // it), so the only other id in reach is the user's, and handing the directory that asks a
    // different tenant's manifest which roles exist.
    expect(directoryAsked()).toEqual([TENANT]);
    // The record the fence produced, not a summary of it — `declaredRoles` is the sorted catalog the
    // warning was drawn against, which is what makes the detail's remedy checkable by its reader.
    expect(warnings[0]?.declaredRoles).toEqual([...DECLARED_ROLES]);
  });

  it("puts the grant's warning in the audit detail, which means before the record ran", async () => {
    const db = fakeDb([[membershipRow({ primary_role: "ghost_role" })]]);
    const { ctx, recorded } = ctxFor(new PostgresUserStore(db.conn));
    const grant = handlerFor(buildPlatformUserRoutes(ctx), "platform.tenants.members.grant");
    await grant({
      principal: principal(),
      params: { tenantId: TENANT },
      request: {},
      parsedBody: { userId: USER, primaryRole: "ghost_role", status: "active" },
    });
    // ADR-0313 puts the record before the write, so a detail assembled afterwards would never be in
    // the row: the recorded event carrying it is the proof of the ordering.
    expect(recorded.events[0]?.operation).toBe("platform.membership_granted");
    expect(warningsOf(recorded.events[0]?.detail)[0]?.role).toBe("ghost_role");
  });

  it("reports an empty list for a declared role rather than omitting the field", async () => {
    const db = fakeDb([[membershipRow()]]);
    const { ctx, recorded } = ctxFor(new PostgresUserStore(db.conn));
    const grant = handlerFor(buildPlatformUserRoutes(ctx), "platform.tenants.members.grant");
    const out = await grant({
      principal: principal(),
      params: { tenantId: TENANT },
      request: {},
      parsedBody: { userId: USER, primaryRole: "erp_admin", secondaryRoles: ["auditor"], status: "active" },
    });
    expect(out.status).toBe(201);
    // ADR-0331: an absent field reads as "none" and is indistinguishable from "not checked", and
    // being told is the whole point of the fence — so `[]` is the claim, present on both carriers.
    expect(warningsOf(out.body)).toEqual([]);
    expect(warningsOf(recorded.events[0]?.detail)).toEqual([]);
  });

  it("warns on the provision path, against the membership's own tenant", async () => {
    const db = fakeDb([[userRow()], [membershipRow()]]);
    const { ctx, recorded, directoryAsked } = ctxFor(new PostgresUserStore(db.conn));
    const provision = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.provision");
    const out = await provision({
      principal: principal(),
      params: {},
      request: {},
      parsedBody: {
        user: { id: USER, email: "ada@example.com" },
        membership: { tenantId: OTHER_TENANT, primaryRole: "ghost_role", status: "active" },
      },
    });
    expect(out.status).toBe(201);
    expect(warningsOf(out.body)[0]?.role).toBe("ghost_role");
    expect(warningsOf(recorded.events[0]?.detail)[0]?.verdict).toBe("not_declared");
    // The body's tenant, which is the title's claim and the one thing the test could not previously
    // see. `OTHER_TENANT` is deliberately neither the caller's nor `USER`, so handing the directory
    // either of those — the two mistakes available at this call site — fails here.
    expect(directoryAsked()).toEqual([OTHER_TENANT]);
  });

  it("checks nothing and claims nothing when the provision body carries no membership", async () => {
    const db = fakeDb([[userRow()]]);
    const { ctx, recorded, directoryCalls } = ctxFor(new PostgresUserStore(db.conn));
    const provision = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.provision");
    const out = await provision({
      principal: principal(),
      params: {},
      request: {},
      parsedBody: { user: { email: "ada@example.com" } },
    });
    expect(out.status).toBe(201);
    expect(warningsOf(out.body)).toEqual([]);
    expect(warningsOf(recorded.events[0]?.detail)).toEqual([]);
    // No membership grants no role, so there is nothing to adjudicate and the directory is not asked.
    expect(directoryCalls()).toBe(0);
  });

  it("reports `unresolved` and never `not_declared` when the directory cannot say", async () => {
    const db = fakeDb([[membershipRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn), { declaredRoles: null });
    const grant = handlerFor(buildPlatformUserRoutes(ctx), "platform.tenants.members.grant");
    const out = await grant({
      principal: principal(),
      params: { tenantId: TENANT },
      request: {},
      parsedBody: { userId: USER, primaryRole: "erp_admin", status: "active" },
    });
    expect(out.status).toBe(201);
    const warnings = warningsOf(out.body);
    expect(warnings.length).toBeGreaterThan(0);
    // Nothing was read, so naming a role undeclared would be a claim about a catalog this
    // deployment could not see — and `declaredRoles` has no list to report.
    expect(warnings.every((w) => w.verdict === "unresolved")).toBe(true);
    expect(warnings.every((w) => w.declaredRoles === null)).toBe(true);
  });

  it("does not gate the write when the directory throws", async () => {
    const db = fakeDb([[membershipRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn), { directoryThrows: true });
    const grant = handlerFor(buildPlatformUserRoutes(ctx), "platform.tenants.members.grant");
    const out = await grant({
      principal: principal(),
      params: { tenantId: TENANT },
      request: {},
      parsedBody: { userId: USER, primaryRole: "erp_admin", status: "active" },
    });
    // A warning changes no status code and no control flow, so an unreachable role catalog must not
    // turn a legal grant into a 500 — `checkMembershipRoles` folds the throw into `unresolved`.
    expect(out.status).toBe(201);
    const warnings = warningsOf(out.body);
    // `erp_admin` is a *declared* role in the default fake, so a throw folded to "all declared"
    // yields `[]` — on which `every` is vacuously true. The length is what distinguishes the two,
    // and without it this test passed for a fence that swallowed the throw entirely.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.verdict).toBe("unresolved");
    expect(warnings[0]?.declaredRoles).toBeNull();
  });

  it("asks the directory once per grant, not once per role", async () => {
    const db = fakeDb([[membershipRow()]]);
    const { ctx, directoryCalls } = ctxFor(new PostgresUserStore(db.conn));
    const grant = handlerFor(buildPlatformUserRoutes(ctx), "platform.tenants.members.grant");
    await grant({
      principal: principal(),
      params: { tenantId: TENANT },
      request: {},
      parsedBody: {
        userId: USER,
        primaryRole: "erp_admin",
        secondaryRoles: ["auditor", "ghost_a", "ghost_b"],
        status: "active",
      },
    });
    expect(directoryCalls()).toBe(1);
  });

  it("does not consult the directory for a body that never parsed", async () => {
    const db = fakeDb([]);
    const { ctx, directoryCalls } = ctxFor(new PostgresUserStore(db.conn));
    const grant = handlerFor(buildPlatformUserRoutes(ctx), "platform.tenants.members.grant");
    const out = await grant({
      principal: principal(),
      params: { tenantId: TENANT },
      request: {},
      parsedBody: { userId: USER, primaryRole: "r" },
    });
    expect(out.status).toBe(400);
    expect(directoryCalls()).toBe(0);
  });
});

/* ----------------------------------------------- ?email= and the refused surfaces */

describe("the user list query surfaces", () => {
  it("binds ?email as a normalised exact match", async () => {
    const db = fakeDb([[userRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const list = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.list");
    const out = await list({
      principal: principal(),
      params: {},
      request: { query: { email: "Ada@Example.COM" } },
    });
    expect(out.status).toBe(200);
    expect(db.captured[0]?.sql).toMatch(/ WHERE email = \$1/);
    // Exact, never a LIKE: `users_email_key` is UNIQUE, so an equality is one indexed row.
    expect(db.captured[0]?.sql).not.toMatch(/LIKE|ILIKE/i);
    expect(db.captured[0]?.params).toEqual(["ada@example.com", 51, 0]);
  });

  it("composes ?email with ?status as two predicates", async () => {
    const db = fakeDb([[userRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const list = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.list");
    await list({
      principal: principal(),
      params: {},
      request: { query: { status: "suspended", email: "ada@example.com" } },
    });
    expect(db.captured[0]?.sql).toMatch(/ WHERE status = \$1 AND email = \$2/);
    expect(db.captured[0]?.params).toEqual(["suspended", "ada@example.com", 51, 0]);
  });

  it("binds an ?email that is not an address rather than refusing it", async () => {
    const db = fakeDb([[]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const list = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.list");
    const out = await list({ principal: principal(), params: {}, request: { query: { email: "nope" } } });
    // The surface is served, so nothing is dropped and ADR-0359 has nothing to refuse: the predicate
    // is bound and zero rows is the right answer to a value the registry cannot hold.
    expect(out.status).toBe(200);
    expect(db.captured[0]?.params).toEqual(["nope", 51, 0]);
  });

  it("treats an empty ?email as the parameter not being supplied", async () => {
    const db = fakeDb([[userRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const list = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.list");
    await list({ principal: principal(), params: {}, request: { query: { email: "" } } });
    expect(db.captured[0]?.sql).not.toMatch(/WHERE/);
  });

  it("400s an undeclared ?status on the users list and names the admissible set", async () => {
    const db = fakeDb([[userRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const list = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.list");
    const out = await list({ principal: principal(), params: {}, request: { query: { status: "bogus" } } });
    // Dropping it returned every row, which is the rows the parameter asked to exclude (ADR-0359).
    expect(out.status).toBe(400);
    const body = out.body as { error: string; detail: string; parameter: string };
    expect(body.error).toBe("status_not_a_declared_value");
    expect(body.parameter).toBe("status");
    expect(body.detail).toMatch(/active, suspended, deleted/);
    expect(db.captured).toHaveLength(0);
  });

  it("400s an undeclared ?status on the members list too, with its own vocabulary", async () => {
    const db = fakeDb([[membershipRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const members = handlerFor(buildPlatformUserRoutes(ctx), "platform.tenants.members.list");
    const out = await members({
      principal: principal(),
      params: { tenantId: TENANT },
      request: { query: { status: "deleted" } },
    });
    // `deleted` is a *user* status and no membership has one — one defect, two handlers, so the
    // shared parser is what keeps the two from drifting apart again.
    expect(out.status).toBe(400);
    expect((out.body as { detail: string }).detail).toMatch(/active, invited, revoked/);
    expect(db.captured).toHaveLength(0);
  });

  it("accepts a declared ?status on the members list", async () => {
    const db = fakeDb([[membershipRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const members = handlerFor(buildPlatformUserRoutes(ctx), "platform.tenants.members.list");
    const out = await members({
      principal: principal(),
      params: { tenantId: TENANT },
      request: { query: { status: "invited" } },
    });
    expect(out.status).toBe(200);
    expect(db.captured[1]?.params).toEqual([TENANT, "invited", 51, 0]);
  });

  it("400s a cursor it did not issue rather than handing back page 1", async () => {
    const db = fakeDb([[userRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const list = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.list");
    const out = await list({ principal: principal(), params: {}, request: { query: { cursor: "garbage" } } });
    expect(out.status).toBe(400);
    expect((out.body as { error: string }).error).toBe("cursor_unreadable");
    expect(db.captured).toHaveLength(0);
  });

  it("accepts a cursor it issued and binds its offset", async () => {
    const first = fakeDb([[userRow({ id: USER }), userRow({ id: OTHER_TENANT })]]);
    const store = new PostgresUserStore(first.conn);
    const page = await store.list({ limit: 1 });
    const cursor = page.nextCursor;
    expect(cursor).not.toBeNull();

    const second = fakeDb([[userRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(second.conn));
    const list = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.list");
    const out = await list({
      principal: principal(),
      params: {},
      request: { query: { cursor: cursor ?? "", limit: "1" } },
    });
    expect(out.status).toBe(200);
    expect(second.captured[0]?.params).toEqual([2, 1]);
  });

  it("400s a ?limit that is not a decimal integer", async () => {
    const db = fakeDb([[userRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const list = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.list");
    for (const limit of ["abc", "1.5", "0x10", "nine"]) {
      const out = await list({ principal: principal(), params: {}, request: { query: { limit } } });
      expect(out.status).toBe(400);
      expect((out.body as { error: string }).error).toBe("limit_not_an_integer");
    }
    expect(db.captured).toHaveLength(0);
  });

  it("clamps a well-formed ?limit that is out of range rather than refusing it", async () => {
    const db = fakeDb([[userRow()], [userRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const list = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.list");
    // The asymmetry is ADR-0359's rule split: a malformed value is a caller mistake they can act
    // on, while `REGISTRY_LIST_MAX_LIMIT` is a platform decision the caller does not get to overrule.
    const high = await list({ principal: principal(), params: {}, request: { query: { limit: "9999" } } });
    expect(high.status).toBe(200);
    expect(db.captured[0]?.params).toEqual([REGISTRY_LIST_MAX_LIMIT + 1, 0]);
    const low = await list({ principal: principal(), params: {}, request: { query: { limit: "0" } } });
    expect(low.status).toBe(200);
    expect(db.captured[1]?.params).toEqual([2, 0]);
  });

  it("clamps a signed ?limit rather than refusing it, which is why the shape admits a sign", async () => {
    const db = fakeDb([[userRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const list = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.list");
    const out = await list({ principal: principal(), params: {}, request: { query: { limit: "-5" } } });
    expect(out.status).toBe(200);
    expect(db.captured[0]?.params).toEqual([2, 0]);
  });

  it("names the predicate first when several parameters are wrong at once", async () => {
    const db = fakeDb([[userRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const list = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.list");
    // The parser's stated precedence: the predicate, then the position within it, then the page
    // size — so a caller who got several wrong is told first about the one that most changed what
    // came back. Unpinned, the next person to reorder those three `if`s decides it by accident.
    const all = await list({
      principal: principal(),
      params: {},
      request: { query: { status: "bogus", cursor: "garbage", limit: "abc" } },
    });
    expect((all.body as { parameter: string }).parameter).toBe("status");
    const two = await list({
      principal: principal(),
      params: {},
      request: { query: { cursor: "garbage", limit: "abc" } },
    });
    expect((two.body as { parameter: string }).parameter).toBe("cursor");
    expect(db.captured).toHaveLength(0);
  });

  it("ignores a parameter that names nothing", async () => {
    const db = fakeDb([[userRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const list = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.list");
    const out = await list({
      principal: principal(),
      params: {},
      request: { query: { utm_source: "ad" } },
    });
    // ADR-0359's own distinction: `?utm_source=ad` names nothing this surface declined to serve.
    expect(out.status).toBe(200);
    expect(db.captured[0]?.sql).not.toMatch(/WHERE/);
  });

  it("answers the offset for a cursor it issued and null for anything else", () => {
    const issued = Buffer.from("o:120", "utf8").toString("base64url");
    expect(decodeUserListCursor(issued)).toBe(120);
    expect(isUserListCursor(issued)).toBe(true);
    for (const raw of ["garbage", "", Buffer.from("x:1", "utf8").toString("base64url")]) {
      expect(decodeUserListCursor(raw)).toBeNull();
      expect(isUserListCursor(raw)).toBe(false);
    }
    // A digit run past the safe-integer range is a cursor nobody issued, not an enormous offset.
    expect(decodeUserListCursor(Buffer.from("o:99999999999999999999", "utf8").toString("base64url"))).toBeNull();
  });

  it("makes the store throw on a cursor it did not issue, rather than serving page 1", async () => {
    const db = fakeDb([[userRow()]]);
    const store = new PostgresUserStore(db.conn);
    await expect(store.list({ cursor: "garbage" })).rejects.toThrow(/cursor/);
    await expect(store.membershipsForTenant(TENANT, { cursor: "garbage" })).rejects.toThrow(/cursor/);
    expect(db.captured).toHaveLength(0);
  });
});

/* ------------------------------------------------- the stats route and the matcher */

describe("the user stats route", () => {
  it("serves the store's counts and records nothing", async () => {
    const db = fakeDb([[{ status: "active", count: 4 }, { status: "deleted", count: 1 }]]);
    const { ctx, recorded } = ctxFor(new PostgresUserStore(db.conn));
    const stats = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.stats");
    const out = await stats({ principal: principal(), params: {}, request: {} });
    expect(out.status).toBe(200);
    expect((out.body as { counts: { active: number; total: number } }).counts).toEqual({
      active: 4,
      suspended: 0,
      deleted: 1,
      total: 5,
    });
    // A read of aggregate figures over the registry, like the list and get routes beside it; the
    // rule that records a read here is about reading the *trail*.
    expect(recorded.events).toHaveLength(0);
  });

  it("is admin-guarded by the same guard as every other route", async () => {
    const db = fakeDb([[]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn), { roles: ["erp_admin"] });
    const stats = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.stats");
    expect((await stats({ principal: null, params: {}, request: {} })).status).toBe(401);
    expect((await stats({ principal: principal(), params: {}, request: {} })).status).toBe(403);
  });

  it("resolves /v1/platform/users/stats through the real matcher, not the id route", () => {
    const db = fakeDb([]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const routes = buildPlatformUserRoutes(ctx).map((r) => r.route);
    const match = matchRoute(routes, "GET", "/v1/platform/users/stats", "v1", new Date(AT));
    expect(match.outcome).toBe("matched");
    expect(match.route?.operationId).toBe("platform.users.stats");
  });

  it("still resolves an id-shaped segment to the get route", () => {
    const db = fakeDb([]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const routes = buildPlatformUserRoutes(ctx).map((r) => r.route);
    const match = matchRoute(routes, "GET", `/v1/platform/users/${USER}`, "v1", new Date(AT));
    expect(match.outcome).toBe("matched");
    expect(match.route?.operationId).toBe("platform.users.get");
    expect(match.pathParameters["id"]).toBe(USER);
  });

  it("answers no_route for a segment that is neither a literal sibling nor an id", () => {
    const db = fakeDb([]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const routes = buildPlatformUserRoutes(ctx).map((r) => r.route);
    // Without the uuid pattern this matched `platform.users.get` and answered a 400 from inside a
    // handler that was never meant for it. There is no such route, which is the honest answer.
    const match = matchRoute(routes, "GET", "/v1/platform/users/not-a-uuid", "v1", new Date(AT));
    expect(match.outcome).toBe("no_route");
    expect(match.route).toBeNull();
  });

  it("admits exactly what the handler's own parse admits, so the matcher routes nothing it refuses", () => {
    const db = fakeDb([]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const segs =
      buildPlatformUserRoutes(ctx).find((r) => r.route.operationId === "platform.users.get")?.route
        .pathSegments ?? [];
    const seg = segs.find((s) => s.kind === "parameter");
    const raw = seg !== undefined && seg.kind === "parameter" ? seg.pattern : null;
    expect(raw).not.toBeNull();
    const pattern = new RegExp(`^${raw ?? ""}$`);
    // `z.string().uuid()` on the resolved zod is a bare hex-and-dashes shape — it pins neither the
    // version nor the variant nibble — so the two coincide and the handler's 400 is unreachable
    // through the matcher. Pinned because the comment on the pattern rests on it: should the parse
    // ever narrow, the matcher would route a segment the handler refuses, which is the 400 the
    // pattern exists to stop.
    for (const candidate of [
      "99999999-9999-4999-8999-999999999999",
      "11111111-1111-1111-1111-111111111111",
      "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      "00000000-0000-0000-0000-000000000000",
      "not-a-uuid",
      "stats",
      "99999999999999999999999999999999",
    ]) {
      expect(pattern.test(candidate)).toBe(z.string().uuid().safeParse(candidate).success);
    }
  });

  it("declares the uuid pattern on the id segment and nowhere it decides nothing", () => {
    const db = fakeDb([]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const routes = buildPlatformUserRoutes(ctx);
    const patternOf = (op: string, name: string): string | null | undefined => {
      const segs = routes.find((r) => r.route.operationId === op)?.route.pathSegments ?? [];
      const seg = segs.find((s) => s.kind === "parameter" && s.name === name);
      return seg !== undefined && seg.kind === "parameter" ? seg.pattern : undefined;
    };
    expect(patternOf("platform.users.get", "id")).toMatch(/^\[0-9a-fA-F\]\{8\}-/);
    // `tenantId` has no literal sibling at its position, so there is nothing for the matcher to
    // separate and the handler's own parse is the whole fence there.
    expect(patternOf("platform.tenants.members.list", "tenantId")).toBeNull();
  });

  it("orders stats ahead of the id route as well, so neither fence stands alone", () => {
    const db = fakeDb([]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const ops = buildPlatformUserRoutes(ctx).map((r) => r.route.operationId);
    expect(ops.indexOf("platform.users.stats")).toBeLessThan(ops.indexOf("platform.users.get"));
  });
});
