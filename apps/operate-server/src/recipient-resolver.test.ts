import type { PgConnection } from "@crossengin/kernel-pg";
import { UserPreferenceMatrixSchema } from "@crossengin/notifications";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ADMIN_ROLES,
  PostgresRecipientResolver,
} from "./recipient-resolver.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const SECONDARY_ADMIN = "00000000-0000-4000-8000-0000000000a2";
const VIEWER = "00000000-0000-4000-8000-0000000000a3";
const SUSPENDED = "00000000-0000-4000-8000-0000000000a4";
const REVOKED = "00000000-0000-4000-8000-0000000000a5";
const OTHER_TENANT_ADMIN = "00000000-0000-4000-8000-0000000000b1";

const NOW = new Date("2026-08-20T12:00:00.000Z");

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly inTx: boolean;
}

/** The tenant-context `SELECT set_config(...)` also starts with SELECT. */
function isRead(captured: Captured): boolean {
  return captured.sql.startsWith("SELECT ") && !captured.sql.includes("set_config");
}

function projectColumns(sql: string, row: Record<string, unknown>): Record<string, unknown> {
  const columns = sql
    .slice("SELECT ".length, sql.indexOf(" FROM "))
    .split(",")
    .map((c) => c.trim().replace(/^[a-z]\./, ""));
  const projected: Record<string, unknown> = {};
  for (const column of columns) projected[column] = row[column];
  return projected;
}

interface FakeDb {
  readonly conn: PgConnection;
  readonly captured: Captured[];
  readonly users: Record<string, unknown>[];
  readonly memberships: Record<string, unknown>[];
  readonly preferences: Record<string, unknown>[];
  readonly suppressions: Record<string, unknown>[];
}

/**
 * A scripted fake PgConnection modelling `meta.user_tenant_membership` joined to
 * the platform-wide `meta.users`, plus the two notification tables. Tenant-scoped
 * rows are only visible once the transaction's `set_config` has established
 * `app.current_tenant_id`, mirroring the real RLS policy, and every predicate is
 * read back out of the recorded SQL + bound params, so a hand-built IN list or an
 * interpolated value would fail the assertions rather than pass silently.
 */
function fakeRecipientDb(): FakeDb {
  const captured: Captured[] = [];
  const users: Record<string, unknown>[] = [];
  const memberships: Record<string, unknown>[] = [];
  const preferences: Record<string, unknown>[] = [];
  const suppressions: Record<string, unknown>[] = [];
  let currentTenant: string | null = null;

  const run = async (
    sql: string,
    params: readonly unknown[] | undefined,
    inTx: boolean,
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    const p = params ?? [];
    captured.push({ sql, params: p, inTx });

    if (sql.includes("set_config")) {
      currentTenant = String(p[0]);
      return { rows: [], rowCount: 0 };
    }

    const tenantId = String(p[0]);
    if (currentTenant !== tenantId) return { rows: [], rowCount: 0 };

    if (sql.includes("user_tenant_membership")) {
      const roleMatch = /\$(\d+)::text\[\]/.exec(sql);
      const userMatch = /m\.user_id = \$(\d+)::uuid/.exec(sql);
      const roles =
        roleMatch === null
          ? null
          : (p[Number.parseInt(roleMatch[1] ?? "0", 10) - 1] as readonly string[]);
      const wantedUser =
        userMatch === null ? null : String(p[Number.parseInt(userMatch[1] ?? "0", 10) - 1]);
      const joined: Record<string, unknown>[] = [];
      for (const m of memberships) {
        if (m["tenant_id"] !== tenantId || m["status"] !== "active") continue;
        if (wantedUser !== null && m["user_id"] !== wantedUser) continue;
        if (roles !== null) {
          const secondary = Array.isArray(m["secondary_roles"])
            ? (m["secondary_roles"] as readonly string[])
            : [];
          const held =
            roles.includes(String(m["primary_role"])) || secondary.some((r) => roles.includes(r));
          if (!held) continue;
        }
        const user = users.find((u) => u["id"] === m["user_id"]);
        if (user === undefined || user["status"] !== "active") continue;
        joined.push({ ...m, email: user["email"], display_name: user["display_name"] });
      }
      const matched = joined
        .sort((a, b) => {
          const byEmail = String(a["email"]).localeCompare(String(b["email"]));
          if (byEmail !== 0) return byEmail;
          return String(a["user_id"]).localeCompare(String(b["user_id"]));
        })
        .map((r) => projectColumns(sql, r));
      return { rows: matched, rowCount: matched.length };
    }

    if (sql.includes("notification_preferences")) {
      const ids = (p[1] as readonly string[] | undefined) ?? [];
      const matched = preferences
        .filter((r) => r["tenant_id"] === tenantId && ids.includes(String(r["user_id"])))
        .sort((a, b) => String(a["user_id"]).localeCompare(String(b["user_id"])))
        .map((r) => projectColumns(sql, r));
      return { rows: matched, rowCount: matched.length };
    }

    if (sql.includes("notification_suppressions")) {
      const channel = String(p[1]);
      const nowMs = Date.parse(String(p[2]));
      const matched = suppressions
        .filter((r) => r["tenant_id"] === tenantId && r["channel"] === channel)
        .filter((r) => r["expires_at"] == null || Date.parse(String(r["expires_at"])) > nowMs)
        .sort((a, b) => Date.parse(String(b["applied_at"])) - Date.parse(String(a["applied_at"])))
        .map((r) => projectColumns(sql, r));
      return { rows: matched, rowCount: matched.length };
    }

    return { rows: [], rowCount: 0 };
  };

  const tx: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) =>
      run(sql, params, true)) as PgConnection["query"],
    transaction: (async () => {
      throw new Error("nested transaction not supported by fake");
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  const conn: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) =>
      run(sql, params, false)) as PgConnection["query"],
    transaction: (async <T>(fn: (t: PgConnection) => Promise<T>) => {
      try {
        return await fn(tx);
      } finally {
        currentTenant = null;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, captured, users, memberships, preferences, suppressions };
}

function seedDirectory(db: FakeDb): void {
  db.users.push(
    { id: ADMIN, email: "admin@a.example", display_name: "A Admin", status: "active" },
    { id: SECONDARY_ADMIN, email: "second@a.example", display_name: null, status: "active" },
    { id: VIEWER, email: "viewer@a.example", display_name: "A Viewer", status: "active" },
    { id: SUSPENDED, email: "suspended@a.example", display_name: null, status: "suspended" },
    { id: REVOKED, email: "revoked@a.example", display_name: null, status: "active" },
    { id: OTHER_TENANT_ADMIN, email: "admin@b.example", display_name: null, status: "active" },
  );
  db.memberships.push(
    { user_id: ADMIN, tenant_id: TENANT_A, primary_role: "erp_admin", secondary_roles: [], status: "active" },
    {
      user_id: SECONDARY_ADMIN,
      tenant_id: TENANT_A,
      primary_role: "erp_viewer",
      secondary_roles: ["tenant_admin", "erp_accountant"],
      status: "active",
    },
    { user_id: VIEWER, tenant_id: TENANT_A, primary_role: "erp_viewer", secondary_roles: [], status: "active" },
    { user_id: SUSPENDED, tenant_id: TENANT_A, primary_role: "erp_admin", secondary_roles: [], status: "active" },
    { user_id: REVOKED, tenant_id: TENANT_A, primary_role: "erp_admin", secondary_roles: [], status: "revoked" },
    {
      user_id: OTHER_TENANT_ADMIN,
      tenant_id: TENANT_B,
      primary_role: "erp_admin",
      secondary_roles: [],
      status: "active",
    },
  );
}

function preferenceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: TENANT_A,
    user_id: ADMIN,
    category: "marketing",
    channel: "email",
    opted_in: true,
    source: "user_set",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function suppressionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    suppression_id: "supp_hardbounce01",
    tenant_id: TENANT_A,
    channel: "email",
    recipient_address: "admin@a.example",
    reason: "hard_bounce",
    applied_at: "2026-08-10T00:00:00.000Z",
    applied_by: null,
    expires_at: null,
    source_delivery_id: null,
    notes: null,
    ...overrides,
  };
}

describe("recipient-resolver — construction", () => {
  it("rejects a malicious schema name before any SQL runs", async () => {
    const db = fakeRecipientDb();
    expect(() => new PostgresRecipientResolver(db.conn, { schema: "public; DROP TABLE x" })).toThrow(
      /invalid schema/,
    );
    expect(() => new PostgresRecipientResolver(db.conn, { schema: "Bad-Schema" })).toThrow(
      /invalid schema/,
    );
    expect(() => new PostgresRecipientResolver(db.conn, { schema: "" })).toThrow(/invalid schema/);
    expect(db.captured).toHaveLength(0);
  });

  it("defaults to meta and interpolates a valid custom schema into every table reference", async () => {
    const db = fakeRecipientDb();
    await new PostgresRecipientResolver(db.conn).activeSuppressions(TENANT_A, "email", NOW);
    expect(db.captured.find((c) => isRead(c))?.sql).toContain("FROM meta.notification_suppressions");
    db.captured.length = 0;
    const resolver = new PostgresRecipientResolver(db.conn, { schema: "ops" });
    await resolver.resolveAudience(TENANT_A, { kind: "tenant_admins", tenantId: TENANT_A });
    await resolver.preferencesFor(TENANT_A, [ADMIN]);
    await resolver.activeSuppressions(TENANT_A, "email", NOW);
    const reads = db.captured.filter((c) => isRead(c));
    expect(reads[0]?.sql).toContain("FROM ops.user_tenant_membership m JOIN ops.users u");
    expect(reads[1]?.sql).toContain("FROM ops.notification_preferences");
    expect(reads[2]?.sql).toContain("FROM ops.notification_suppressions");
  });
});

describe("recipient-resolver — tenant context", () => {
  it("resolves an audience inside withTenantContext with tenant_id also bound as $1", async () => {
    const db = fakeRecipientDb();
    seedDirectory(db);
    const resolver = new PostgresRecipientResolver(db.conn);
    await resolver.resolveAudience(TENANT_A, { kind: "tenant_admins", tenantId: TENANT_A });
    const setConfig = db.captured.find((c) => c.sql.includes("set_config"));
    expect(setConfig?.sql).toContain("app.current_tenant_id");
    expect(setConfig?.params).toEqual([TENANT_A]);
    expect(setConfig?.inTx).toBe(true);
    const read = db.captured.find((c) => isRead(c));
    expect(read?.inTx).toBe(true);
    expect(read?.sql).toContain("m.tenant_id = $1");
    expect(read?.params[0]).toBe(TENANT_A);
  });

  it("reads preferences and suppressions inside withTenantContext with tenant_id also bound as $1", async () => {
    const db = fakeRecipientDb();
    const resolver = new PostgresRecipientResolver(db.conn);
    await resolver.preferencesFor(TENANT_A, [ADMIN]);
    await resolver.activeSuppressions(TENANT_A, "email", NOW);
    const setConfigs = db.captured.filter((c) => c.sql.includes("set_config"));
    expect(setConfigs).toHaveLength(2);
    for (const setConfig of setConfigs) {
      expect(setConfig.sql).toContain("app.current_tenant_id");
      expect(setConfig.params).toEqual([TENANT_A]);
      expect(setConfig.inTx).toBe(true);
    }
    const reads = db.captured.filter((c) => isRead(c));
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read.inTx).toBe(true);
      expect(read.sql).toContain("WHERE tenant_id = $1");
      expect(read.params[0]).toBe(TENANT_A);
    }
  });

  it("rejects a malformed tenant id before any SQL is issued", async () => {
    const db = fakeRecipientDb();
    const resolver = new PostgresRecipientResolver(db.conn);
    const evil = "robert'); DROP TABLE users;--";
    await expect(resolver.resolveAudience(evil, { kind: "specific_user", userId: ADMIN })).rejects.toThrow(
      /invalid tenantId/,
    );
    await expect(resolver.preferencesFor(evil, [ADMIN])).rejects.toThrow(/invalid tenantId/);
    await expect(resolver.activeSuppressions(evil, "email", NOW)).rejects.toThrow(/invalid tenantId/);
    expect(db.captured).toHaveLength(0);
  });

  it("never puts a tenant id, a user id, or a timestamp in any SQL string", async () => {
    const db = fakeRecipientDb();
    seedDirectory(db);
    const resolver = new PostgresRecipientResolver(db.conn);
    await resolver.resolveAudience(TENANT_A, { kind: "tenant_admins", tenantId: TENANT_A });
    await resolver.resolveAudience(TENANT_A, { kind: "specific_user", userId: ADMIN });
    await resolver.resolveAudience(TENANT_A, {
      kind: "role_in_tenant",
      tenantId: TENANT_A,
      roleSlug: "erp_viewer",
    });
    await resolver.preferencesFor(TENANT_A, [ADMIN, VIEWER]);
    await resolver.activeSuppressions(TENANT_A, "email", NOW);
    expect(db.captured.length).toBeGreaterThan(0);
    for (const call of db.captured) {
      expect(call.sql).not.toContain(TENANT_A);
      expect(call.sql).not.toContain(ADMIN);
      expect(call.sql).not.toContain(VIEWER);
      expect(call.sql).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    }
  });
});

describe("recipient-resolver — resolveAudience", () => {
  it("resolves tenant_admins to active members holding an admin primary role", async () => {
    const db = fakeRecipientDb();
    seedDirectory(db);
    const resolver = new PostgresRecipientResolver(db.conn);
    const recipients = await resolver.resolveAudience(TENANT_A, {
      kind: "tenant_admins",
      tenantId: TENANT_A,
    });
    expect(recipients.map((r) => r.userId)).toContain(ADMIN);
    expect(recipients.map((r) => r.userId)).not.toContain(VIEWER);
    expect(recipients.find((r) => r.userId === ADMIN)?.email).toBe("admin@a.example");
    expect(recipients.find((r) => r.userId === ADMIN)?.primaryRole).toBe("erp_admin");
  });

  it("matches an admin held only in secondary_roles via array overlap", async () => {
    const db = fakeRecipientDb();
    seedDirectory(db);
    const resolver = new PostgresRecipientResolver(db.conn);
    const recipients = await resolver.resolveAudience(TENANT_A, {
      kind: "tenant_admins",
      tenantId: TENANT_A,
    });
    const secondary = recipients.find((r) => r.userId === SECONDARY_ADMIN);
    expect(secondary).toBeDefined();
    expect(secondary?.secondaryRoles).toEqual(["tenant_admin", "erp_accountant"]);
    const read = db.captured.find((c) => isRead(c));
    expect(read?.sql).toContain(
      "(m.primary_role = ANY($2::text[]) OR m.secondary_roles && $2::text[])",
    );
    expect(read?.params).toEqual([TENANT_A, [...DEFAULT_ADMIN_ROLES]]);
    for (const role of DEFAULT_ADMIN_ROLES) expect(read?.sql).not.toContain(role);
  });

  it("honours a custom adminRoles option", async () => {
    const db = fakeRecipientDb();
    seedDirectory(db);
    const resolver = new PostgresRecipientResolver(db.conn, { adminRoles: ["erp_viewer"] });
    const recipients = await resolver.resolveAudience(TENANT_A, {
      kind: "tenant_admins",
      tenantId: TENANT_A,
    });
    expect(recipients.map((r) => r.userId).sort()).toEqual([SECONDARY_ADMIN, VIEWER].sort());
    expect(db.captured.find((c) => isRead(c))?.params[1]).toEqual(["erp_viewer"]);
  });

  it("resolves nobody, and issues no query, when adminRoles is empty", async () => {
    const db = fakeRecipientDb();
    seedDirectory(db);
    const resolver = new PostgresRecipientResolver(db.conn, { adminRoles: [] });
    const recipients = await resolver.resolveAudience(TENANT_A, {
      kind: "tenant_admins",
      tenantId: TENANT_A,
    });
    expect(recipients).toEqual([]);
    expect(db.captured).toHaveLength(0);
  });

  it("resolves role_in_tenant to members holding that role", async () => {
    const db = fakeRecipientDb();
    seedDirectory(db);
    const resolver = new PostgresRecipientResolver(db.conn);
    const recipients = await resolver.resolveAudience(TENANT_A, {
      kind: "role_in_tenant",
      tenantId: TENANT_A,
      roleSlug: "erp_accountant",
    });
    expect(recipients.map((r) => r.userId)).toEqual([SECONDARY_ADMIN]);
    expect(db.captured.find((c) => isRead(c))?.params[1]).toEqual(["erp_accountant"]);
  });

  it("resolves specific_user to that single active member", async () => {
    const db = fakeRecipientDb();
    seedDirectory(db);
    const resolver = new PostgresRecipientResolver(db.conn);
    const recipients = await resolver.resolveAudience(TENANT_A, {
      kind: "specific_user",
      userId: VIEWER,
    });
    expect(recipients.map((r) => r.userId)).toEqual([VIEWER]);
    const read = db.captured.find((c) => isRead(c));
    expect(read?.sql).toContain("m.user_id = $2::uuid");
    expect(read?.params).toEqual([TENANT_A, VIEWER]);
  });

  it("resolves specific_user to empty when the user is not a member of this tenant", async () => {
    const db = fakeRecipientDb();
    seedDirectory(db);
    const resolver = new PostgresRecipientResolver(db.conn);
    const recipients = await resolver.resolveAudience(TENANT_A, {
      kind: "specific_user",
      userId: OTHER_TENANT_ADMIN,
    });
    expect(recipients).toEqual([]);
  });

  it("resolves tenant_all_users to every active member", async () => {
    const db = fakeRecipientDb();
    seedDirectory(db);
    const resolver = new PostgresRecipientResolver(db.conn);
    const recipients = await resolver.resolveAudience(TENANT_A, {
      kind: "tenant_all_users",
      tenantId: TENANT_A,
    });
    expect(recipients.map((r) => r.userId).sort()).toEqual([ADMIN, SECONDARY_ADMIN, VIEWER].sort());
  });

  it("resolves an audience naming another tenant to empty without issuing a query", async () => {
    const db = fakeRecipientDb();
    seedDirectory(db);
    const resolver = new PostgresRecipientResolver(db.conn);
    expect(
      await resolver.resolveAudience(TENANT_A, { kind: "tenant_admins", tenantId: TENANT_B }),
    ).toEqual([]);
    expect(
      await resolver.resolveAudience(TENANT_A, {
        kind: "role_in_tenant",
        tenantId: TENANT_B,
        roleSlug: "erp_admin",
      }),
    ).toEqual([]);
    expect(
      await resolver.resolveAudience(TENANT_A, { kind: "tenant_all_users", tenantId: TENANT_B }),
    ).toEqual([]);
    expect(db.captured).toHaveLength(0);
  });

  it("never leaks another tenant's members even when that tenant has admins", async () => {
    const db = fakeRecipientDb();
    seedDirectory(db);
    const resolver = new PostgresRecipientResolver(db.conn);
    const recipients = await resolver.resolveAudience(TENANT_A, {
      kind: "tenant_admins",
      tenantId: TENANT_A,
    });
    expect(recipients.map((r) => r.userId)).not.toContain(OTHER_TENANT_ADMIN);
    const forB = await resolver.resolveAudience(TENANT_B, {
      kind: "tenant_admins",
      tenantId: TENANT_B,
    });
    expect(forB.map((r) => r.userId)).toEqual([OTHER_TENANT_ADMIN]);
  });

  it("returns an empty array for an unrecognised or malformed audience, never throwing", async () => {
    const db = fakeRecipientDb();
    seedDirectory(db);
    const resolver = new PostgresRecipientResolver(db.conn);
    const bad: readonly unknown[] = [
      null,
      undefined,
      "tenant_admins",
      42,
      [],
      {},
      { kind: "nope" },
      { kind: "tenant_admins" },
      { kind: "tenant_admins", tenantId: "not-a-uuid" },
      { kind: "role_in_tenant", tenantId: TENANT_A },
      { kind: "role_in_tenant", tenantId: TENANT_A, roleSlug: "Bad Role" },
      { kind: "specific_user", userId: "nope" },
      { kind: "specific_address", channel: "email", address: "x@y.example" },
      { kind: "custom_predicate", tenantId: TENANT_A, predicate: "1=1", description: "" },
    ];
    for (const audience of bad) {
      expect(await resolver.resolveAudience(TENANT_A, audience)).toEqual([]);
    }
    expect(db.captured).toHaveLength(0);
  });

  it("excludes revoked memberships and non-active users", async () => {
    const db = fakeRecipientDb();
    seedDirectory(db);
    const resolver = new PostgresRecipientResolver(db.conn);
    const recipients = await resolver.resolveAudience(TENANT_A, {
      kind: "tenant_admins",
      tenantId: TENANT_A,
    });
    const ids = recipients.map((r) => r.userId);
    expect(ids).not.toContain(REVOKED);
    expect(ids).not.toContain(SUSPENDED);
    const read = db.captured.find((c) => isRead(c));
    expect(read?.sql).toContain("m.status = 'active'");
    expect(read?.sql).toContain("u.status = 'active'");
  });

  it("deduplicates by user_id when the join yields a repeated row", async () => {
    const db = fakeRecipientDb();
    seedDirectory(db);
    db.memberships.push({
      user_id: ADMIN,
      tenant_id: TENANT_A,
      primary_role: "platform_admin",
      secondary_roles: [],
      status: "active",
    });
    const resolver = new PostgresRecipientResolver(db.conn);
    const recipients = await resolver.resolveAudience(TENANT_A, {
      kind: "tenant_admins",
      tenantId: TENANT_A,
    });
    expect(recipients.filter((r) => r.userId === ADMIN)).toHaveLength(1);
  });

  it("maps a null display_name to null and a missing role array to an empty list", async () => {
    const db = fakeRecipientDb();
    seedDirectory(db);
    const membership = db.memberships.find((m) => m["user_id"] === SECONDARY_ADMIN);
    if (membership !== undefined) membership["secondary_roles"] = null;
    const resolver = new PostgresRecipientResolver(db.conn);
    const recipients = await resolver.resolveAudience(TENANT_A, {
      kind: "specific_user",
      userId: SECONDARY_ADMIN,
    });
    expect(recipients[0]?.displayName).toBeNull();
    expect(recipients[0]?.secondaryRoles).toEqual([]);
  });
});

describe("recipient-resolver — preferencesFor", () => {
  it("returns one matrix per requested user built from the stored rows", async () => {
    const db = fakeRecipientDb();
    db.preferences.push(
      preferenceRow({ user_id: ADMIN, category: "marketing", channel: "email", opted_in: true }),
      preferenceRow({
        user_id: ADMIN,
        category: "operational_digest",
        channel: "sms",
        opted_in: false,
        updated_at: new Date("2026-08-05T06:07:08.000Z"),
      }),
      preferenceRow({ user_id: VIEWER, category: "marketing", channel: "email", opted_in: false }),
    );
    const resolver = new PostgresRecipientResolver(db.conn);
    const matrices = await resolver.preferencesFor(TENANT_A, [ADMIN, VIEWER]);
    expect(matrices.size).toBe(2);
    expect(matrices.get(ADMIN)?.entries).toHaveLength(2);
    expect(matrices.get(ADMIN)?.entries[1]?.updatedAt).toBe("2026-08-05T06:07:08.000Z");
    expect(matrices.get(ADMIN)?.updatedAt).toBe("2026-08-05T06:07:08.000Z");
    expect(matrices.get(VIEWER)?.entries).toEqual([
      {
        category: "marketing",
        channel: "email",
        optedIn: false,
        updatedAt: "2026-08-01T00:00:00.000Z",
        source: "user_set",
      },
    ]);
  });

  it("gives a user with no stored rows a valid matrix with empty entries", async () => {
    const db = fakeRecipientDb();
    const resolver = new PostgresRecipientResolver(db.conn);
    const matrices = await resolver.preferencesFor(TENANT_A, [ADMIN]);
    const matrix = matrices.get(ADMIN);
    expect(matrix).toBeDefined();
    expect(matrix?.entries).toEqual([]);
    expect(matrix?.userId).toBe(ADMIN);
    expect(matrix?.tenantId).toBe(TENANT_A);
  });

  it("returns matrices that all pass UserPreferenceMatrixSchema.parse", async () => {
    const db = fakeRecipientDb();
    db.preferences.push(
      preferenceRow({ user_id: ADMIN }),
      preferenceRow({ user_id: VIEWER, category: "system_notice", channel: "in_app" }),
    );
    const resolver = new PostgresRecipientResolver(db.conn);
    const matrices = await resolver.preferencesFor(TENANT_A, [ADMIN, VIEWER, SECONDARY_ADMIN]);
    expect(matrices.size).toBe(3);
    for (const matrix of matrices.values()) {
      expect(() => UserPreferenceMatrixSchema.parse(matrix)).not.toThrow();
    }
  });

  it("binds the user id list as a single uuid[] parameter with = ANY", async () => {
    const db = fakeRecipientDb();
    const resolver = new PostgresRecipientResolver(db.conn);
    await resolver.preferencesFor(TENANT_A, [ADMIN, VIEWER]);
    const read = db.captured.find((c) => isRead(c));
    expect(read?.sql).toContain("user_id = ANY($2::uuid[])");
    expect(read?.sql).not.toContain(" IN (");
    expect(read?.params).toEqual([TENANT_A, [ADMIN, VIEWER]]);
  });

  it("returns an empty map without issuing any query for an empty user list", async () => {
    const db = fakeRecipientDb();
    const resolver = new PostgresRecipientResolver(db.conn);
    const matrices = await resolver.preferencesFor(TENANT_A, []);
    expect(matrices.size).toBe(0);
    expect(db.captured).toHaveLength(0);
  });

  it("deduplicates requested ids and drops non-uuid ids without querying for them", async () => {
    const db = fakeRecipientDb();
    const resolver = new PostgresRecipientResolver(db.conn);
    const matrices = await resolver.preferencesFor(TENANT_A, [ADMIN, ADMIN, "not-a-uuid"]);
    expect([...matrices.keys()]).toEqual([ADMIN]);
    expect(db.captured.find((c) => isRead(c))?.params[1]).toEqual([ADMIN]);
    await resolver.preferencesFor(TENANT_A, ["nope", ""]);
    expect(db.captured.filter((c) => isRead(c))).toHaveLength(1);
  });

  it("drops a stored row with an unrecognised category rather than throwing", async () => {
    const db = fakeRecipientDb();
    db.preferences.push(
      preferenceRow({ user_id: ADMIN, category: "gossip" }),
      preferenceRow({ user_id: ADMIN, category: "marketing", channel: "sms" }),
    );
    const resolver = new PostgresRecipientResolver(db.conn);
    const matrices = await resolver.preferencesFor(TENANT_A, [ADMIN]);
    expect(matrices.get(ADMIN)?.entries.map((e) => e.category)).toEqual(["marketing"]);
  });

  it("degrades an internally inconsistent row set to an empty matrix", async () => {
    const db = fakeRecipientDb();
    db.preferences.push(
      preferenceRow({
        user_id: ADMIN,
        category: "security_alert",
        channel: "email",
        opted_in: false,
        source: "user_set",
      }),
    );
    const resolver = new PostgresRecipientResolver(db.conn);
    const matrices = await resolver.preferencesFor(TENANT_A, [ADMIN]);
    expect(matrices.get(ADMIN)?.entries).toEqual([]);
    expect(() => UserPreferenceMatrixSchema.parse(matrices.get(ADMIN))).not.toThrow();
  });

  it("never returns another tenant's preference rows", async () => {
    const db = fakeRecipientDb();
    db.preferences.push(
      preferenceRow({ tenant_id: TENANT_B, user_id: ADMIN, category: "marketing" }),
    );
    const resolver = new PostgresRecipientResolver(db.conn);
    const matrices = await resolver.preferencesFor(TENANT_A, [ADMIN]);
    expect(matrices.get(ADMIN)?.entries).toEqual([]);
  });
});

describe("recipient-resolver — activeSuppressions", () => {
  it("returns schema-valid suppression records for the requested channel", async () => {
    const db = fakeRecipientDb();
    db.suppressions.push(suppressionRow());
    const resolver = new PostgresRecipientResolver(db.conn);
    const records = await resolver.activeSuppressions(TENANT_A, "email", NOW);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe("supp_hardbounce01");
    expect(records[0]?.recipientAddress).toBe("admin@a.example");
    expect(records[0]?.reason).toBe("hard_bounce");
    expect(records[0]?.expiresAt).toBeNull();
  });

  it("filters out expired rows in SQL with now bound, keeping a future expiry", async () => {
    const db = fakeRecipientDb();
    db.suppressions.push(
      suppressionRow({
        suppression_id: "supp_expired001",
        reason: "soft_bounce_exceeded",
        applied_at: "2026-08-01T00:00:00.000Z",
        expires_at: "2026-08-15T00:00:00.000Z",
      }),
      suppressionRow({
        suppression_id: "supp_soft000001",
        reason: "soft_bounce_exceeded",
        applied_at: "2026-08-01T00:00:00.000Z",
        expires_at: "2026-09-01T00:00:00.000Z",
      }),
    );
    const resolver = new PostgresRecipientResolver(db.conn);
    const records = await resolver.activeSuppressions(TENANT_A, "email", NOW);
    expect(records.map((r) => r.id)).toEqual(["supp_soft000001"]);
    expect(records[0]?.expiresAt).toBe("2026-09-01T00:00:00.000Z");
    const read = db.captured.find((c) => isRead(c));
    expect(read?.sql).toContain("(expires_at IS NULL OR expires_at > $3)");
    expect(read?.params).toEqual([TENANT_A, "email", NOW.toISOString()]);
    expect(read?.sql).not.toContain(NOW.toISOString());
  });

  it("filters by channel with the channel bound as $2", async () => {
    const db = fakeRecipientDb();
    db.suppressions.push(
      suppressionRow(),
      suppressionRow({
        suppression_id: "supp_smsblock01",
        channel: "sms",
        recipient_address: "+15550001111",
      }),
    );
    const resolver = new PostgresRecipientResolver(db.conn);
    const sms = await resolver.activeSuppressions(TENANT_A, "sms", NOW);
    expect(sms.map((r) => r.id)).toEqual(["supp_smsblock01"]);
    expect(db.captured.find((c) => isRead(c))?.params[1]).toBe("sms");
    expect(db.captured.find((c) => isRead(c))?.sql).toContain("channel = $2");
  });

  it("drops a row that fails SuppressionRecordSchema rather than throwing", async () => {
    const db = fakeRecipientDb();
    db.suppressions.push(
      suppressionRow({ suppression_id: "supp_bad0000001", reason: "made_up_reason" }),
      suppressionRow({ suppression_id: "supp_badid" }),
      suppressionRow(),
    );
    const resolver = new PostgresRecipientResolver(db.conn);
    const records = await resolver.activeSuppressions(TENANT_A, "email", NOW);
    expect(records.map((r) => r.id)).toEqual(["supp_hardbounce01"]);
  });

  it("carries optional notes through and normalizes a Date-valued applied_at", async () => {
    const db = fakeRecipientDb();
    db.suppressions.push(
      suppressionRow({
        applied_at: new Date("2026-08-10T01:02:03.000Z"),
        notes: "reported by the provider",
      }),
    );
    const resolver = new PostgresRecipientResolver(db.conn);
    const records = await resolver.activeSuppressions(TENANT_A, "email", NOW);
    expect(records[0]?.appliedAt).toBe("2026-08-10T01:02:03.000Z");
    expect(records[0]?.notes).toBe("reported by the provider");
  });

  it("never returns another tenant's suppressions", async () => {
    const db = fakeRecipientDb();
    db.suppressions.push(
      suppressionRow(),
      suppressionRow({ suppression_id: "supp_othertenant1", tenant_id: TENANT_B }),
    );
    const resolver = new PostgresRecipientResolver(db.conn);
    const forA = await resolver.activeSuppressions(TENANT_A, "email", NOW);
    const forB = await resolver.activeSuppressions(TENANT_B, "email", NOW);
    expect(forA.map((r) => r.id)).toEqual(["supp_hardbounce01"]);
    expect(forB.map((r) => r.id)).toEqual(["supp_othertenant1"]);
    expect(await resolver.activeSuppressions(TENANT_A, "push_mobile", NOW)).toEqual([]);
  });
});
