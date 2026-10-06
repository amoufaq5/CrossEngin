import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  CreateUserInputSchema,
  DuplicateMembershipError,
  DuplicateUserError,
  GrantMembershipInputSchema,
  MEMBERSHIP_STATUSES,
  MEMBERSHIP_STATUS_TRANSITIONS,
  MembershipRecordSchema,
  PostgresUserStore,
  REGISTRY_REFUSED_OPERATION,
  USER_STATUSES,
  USER_STATUS_TRANSITIONS,
  UnknownPrincipalError,
  UserRecordSchema,
  buildPlatformUserRoutes,
  canTransitionMembership,
  canTransitionUser,
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

function ctxFor(
  store: PostgresUserStore,
  opts: { readonly roles?: readonly string[]; readonly auditThrows?: boolean } = {},
): { ctx: Parameters<typeof buildPlatformUserRoutes>[0]; recorded: Recorded } {
  const recorded: Recorded = { events: [] };
  return {
    recorded,
    ctx: {
      store,
      principalRoles: () => ({ primaryRole: (opts.roles ?? ["platform_admin"])[0] ?? "anonymous" }),
      adminRoles: new Set(["platform_admin"]),
      audit: async (e) => {
        if (opts.auditThrows === true) throw new Error("audit down");
        recorded.events.push(e);
      },
      clock: () => new Date(AT),
    },
    };
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
        audit: undefined as unknown as (e: UserRegistryAuditEvent) => Promise<void>,
      }),
    ).toThrow(/require an auditor/);
  });

  it("exposes ten routes and no duplicate operation id", () => {
    const { conn } = fakeDb([]);
    const { ctx } = ctxFor(new PostgresUserStore(conn));
    const routes = buildPlatformUserRoutes(ctx);
    expect(routes).toHaveLength(10);
    expect(new Set(routes.map((r) => r.route.operationId)).size).toBe(10);
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

  it("ignores an unrecognised ?status rather than erroring, as the tenant list does", async () => {
    const db = fakeDb([[userRow()]]);
    const { ctx } = ctxFor(new PostgresUserStore(db.conn));
    const list = handlerFor(buildPlatformUserRoutes(ctx), "platform.users.list");
    const out = await list({ principal: principal(), params: {}, request: { query: { status: "zzz" } } });
    expect(out.status).toBe(200);
    expect(db.captured[0]?.sql).not.toMatch(/WHERE status/);
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
