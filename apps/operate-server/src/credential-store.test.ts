import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { PostgresCredentialStore } from "./credential-store.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const HASH = `scrypt$32768$8$1$${"a".repeat(32)}$${"b".repeat(128)}`;

type Row = Record<string, unknown>;

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Records every statement and **throws** on the two things a pure recorder would wave through,
 * following `platform-users.test.ts`:
 *
 *  - a `tenant_id` predicate on `meta.users`, because that column does not exist there (ADR-0332's
 *    `default_value` defect: a fake asserting SQL shape cannot know a column is absent);
 *  - a `set_config` call, because **neither** of these tables carries RLS, so a tenant context
 *    here would be a sign that this store had acquired the membership read it deliberately does
 *    not own.
 *
 * The fallback arm returns an empty row set rather than throwing, which is the one place this
 * departs from ADR-0350's rule -- these statements are each asserted by shape below, and an
 * `UPDATE` legitimately answers no rows.
 */
function fakeDb(responses: readonly Row[][]): {
  conn: PgConnection;
  captured: Captured[];
  sql: () => string;
} {
  const captured: Captured[] = [];
  let next = 0;
  const run = async (
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }> => {
    captured.push({ sql, params: params ?? [] });
    if (sql.includes("set_config")) {
      throw new Error(
        "this fake refuses a tenant context: neither meta.users nor meta.tenants carries RLS, and" +
          " the scoped membership read belongs to PostgresUserStore",
      );
    }
    if (/\busers\b/.test(sql) && /tenant_id/.test(sql)) {
      throw new Error(
        `this fake refuses a tenant_id predicate on meta.users: the column does not exist — ${sql.slice(0, 120)}`,
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
  return { conn, captured, sql: () => captured.map((c) => c.sql).join("\n---\n") };
}

describe("PostgresCredentialStore", () => {
  it("validates the schema name", () => {
    const { conn } = fakeDb([]);
    expect(() => new PostgresCredentialStore(conn, { schema: "meta; drop table users" })).toThrow(
      /invalid schema identifier/,
    );
    expect(() => new PostgresCredentialStore(conn)).not.toThrow();
  });

  describe("resolveTenant", () => {
    it("resolves a slug and a uuid through ONE statement", async () => {
      // One statement rather than a branch, so a slug that happens to look like a UUID cannot take
      // a different path than the one the operator meant.
      const { conn, captured } = fakeDb([[{ id: TENANT, status: "active" }]]);
      const store = new PostgresCredentialStore(conn);
      expect(await store.resolveTenant("acme")).toEqual({ tenantId: TENANT, status: "active" });
      expect(captured).toHaveLength(1);
      expect(captured[0]!.sql).toContain("FROM meta.tenants");
      expect(captured[0]!.sql).toContain("slug = $1");
      expect(captured[0]!.sql).toContain("id = $2::uuid");
      expect(captured[0]!.params).toEqual(["acme", null]);
    });

    it("passes a lowercased uuid as the second parameter", async () => {
      const { conn, captured } = fakeDb([[{ id: TENANT, status: "active" }]]);
      const store = new PostgresCredentialStore(conn);
      await store.resolveTenant(TENANT.toUpperCase());
      expect(captured[0]!.params).toEqual([TENANT.toUpperCase(), TENANT]);
    });

    it("answers null for an empty ref without issuing a statement", async () => {
      const { conn, captured } = fakeDb([]);
      const store = new PostgresCredentialStore(conn);
      expect(await store.resolveTenant("   ")).toBeNull();
      expect(captured).toHaveLength(0);
    });

    it("answers null for no row", async () => {
      const { conn } = fakeDb([[]]);
      expect(await new PostgresCredentialStore(conn).resolveTenant("nope")).toBeNull();
    });
  });

  describe("findByEmail", () => {
    it("names the credential columns and NOT the user-record ones", async () => {
      // `USER_COLUMNS` feeds seven statements and `UserRecordSchema` is `.strict()`, so sharing it
      // would either throw on every registry read or put the hash in six 200 bodies.
      const { conn, captured } = fakeDb([
        [
          {
            id: USER,
            status: "active",
            credential_hash: HASH,
            credential_failed_attempts: 2,
            credential_locked_until: null,
          },
        ],
      ]);
      const store = new PostgresCredentialStore(conn);
      expect(await store.findByEmail("A@Example.Test ")).toEqual({
        userId: USER,
        status: "active",
        credentialHash: HASH,
        failedAttempts: 2,
        lockedUntil: null,
      });
      const sql = captured[0]!.sql;
      expect(sql).toContain("credential_hash");
      expect(sql).toContain("credential_failed_attempts");
      expect(sql).toContain("credential_locked_until");
      expect(sql).not.toContain("display_name");
      expect(sql).not.toContain("phone_e164");
      expect(sql).not.toContain("last_login_at");
    });

    it("normalizes the email, so a mixed-case login finds the row", async () => {
      const { conn, captured } = fakeDb([[]]);
      await new PostgresCredentialStore(conn).findByEmail("  A@Example.Test  ");
      expect(captured[0]!.params).toEqual(["a@example.test"]);
    });

    it("reads an absent or empty hash as null", async () => {
      // The null means *this user has no password*, and every existing row on every deployment is
      // in that state -- so it must not become a pass anywhere downstream.
      for (const value of [null, undefined, ""]) {
        const { conn } = fakeDb([
          [{ id: USER, status: "active", credential_hash: value, credential_failed_attempts: 0 }],
        ]);
        const record = await new PostgresCredentialStore(conn).findByEmail("a@b.test");
        expect(record?.credentialHash, String(value)).toBeNull();
      }
    });

    it("defaults a missing attempt count to zero rather than NaN", async () => {
      const { conn } = fakeDb([[{ id: USER, status: "active", credential_hash: HASH }]]);
      const record = await new PostgresCredentialStore(conn).findByEmail("a@b.test");
      expect(record?.failedAttempts).toBe(0);
    });

    it("normalizes a Date lock to an ISO instant", async () => {
      // node-postgres hands back a `Date` for TIMESTAMPTZ, and `Date.prototype.toString()` is not
      // a form Postgres can parse back -- ADR-0331's class, which is why this goes through
      // `isoInstant` rather than `String()`.
      const when = new Date("2026-10-11T12:00:00.000Z");
      const { conn } = fakeDb([
        [
          {
            id: USER,
            status: "active",
            credential_hash: HASH,
            credential_failed_attempts: 1,
            credential_locked_until: when,
          },
        ],
      ]);
      const record = await new PostgresCredentialStore(conn).findByEmail("a@b.test");
      expect(record?.lockedUntil).toBe("2026-10-11T12:00:00.000Z");
    });

    it("answers null for an unknown email", async () => {
      const { conn } = fakeDb([[]]);
      expect(await new PostgresCredentialStore(conn).findByEmail("x@y.test")).toBeNull();
    });
  });

  describe("recordFailure", () => {
    it("increments and locks in ONE statement, reading the clock from the database", async () => {
      // Read-modify-write is what this must not be: the losing side of that race ADMITS an
      // attempt, so two concurrent guesses would advance the counter by one. And the lock comes
      // from `now()` rather than the process clock, so a drifted worker cannot unlock early.
      const { conn, captured } = fakeDb([
        [{ credential_failed_attempts: 10, credential_locked_until: "2026-10-11T12:15:00.000Z" }],
      ]);
      const store = new PostgresCredentialStore(conn);
      const r = await store.recordFailure(USER, 10, 900);
      expect(r).toEqual({ failedAttempts: 10, lockedUntil: "2026-10-11T12:15:00.000Z" });
      expect(captured).toHaveLength(1);
      const sql = captured[0]!.sql;
      expect(sql).toMatch(/^UPDATE meta\.users SET/);
      expect(sql).toContain("credential_failed_attempts = credential_failed_attempts + 1");
      expect(sql).toContain("now() + make_interval");
      expect(sql).toContain("RETURNING");
      expect(captured[0]!.params).toEqual([USER, 10, 900]);
      // The threshold is compared against the POST-increment value, or the lock lands one attempt
      // late and the configured figure means something other than what it says.
      expect(sql).toContain("credential_failed_attempts + 1 >= $2");
    });

    it("preserves an existing lock rather than clearing it below the threshold", async () => {
      const { conn, captured } = fakeDb([[{ credential_failed_attempts: 1 }]]);
      await new PostgresCredentialStore(conn).recordFailure(USER, 10, 900);
      expect(captured[0]!.sql).toContain("ELSE credential_locked_until END");
    });

    it("answers zero for a user that does not exist", async () => {
      const { conn } = fakeDb([[]]);
      expect(await new PostgresCredentialStore(conn).recordFailure(USER, 3, 30)).toEqual({
        failedAttempts: 0,
        lockedUntil: null,
      });
    });
  });

  describe("recordSuccess", () => {
    it("clears the counter and the lock and stamps last_login_at", async () => {
      // The first writer `last_login_at` has ever had. `access-reviews`' dormancy predicate reads
      // it and today answers "dormant" for every principal because nothing wrote it.
      const { conn, captured } = fakeDb([[]]);
      await new PostgresCredentialStore(conn).recordSuccess(USER);
      const sql = captured[0]!.sql;
      expect(sql).toContain("credential_failed_attempts = 0");
      expect(sql).toContain("credential_locked_until = NULL");
      expect(sql).toContain("last_login_at = now()");
      expect(captured[0]!.params).toEqual([USER]);
    });
  });

  describe("setCredential", () => {
    it("stores the hash, stamps it and clears any lock", async () => {
      const { conn, captured } = fakeDb([[{}]]);
      const ok = await new PostgresCredentialStore(conn).setCredential(USER, HASH);
      expect(ok).toBe(true);
      const sql = captured[0]!.sql;
      expect(sql).toContain("credential_hash = $2");
      expect(sql).toContain("credential_updated_at = now()");
      expect(sql).toContain("credential_locked_until = NULL");
      expect(captured[0]!.params).toEqual([USER, HASH]);
    });

    it("reports false for a user that does not exist", async () => {
      // Rather than reporting a success it did not have: `set-credential` exits 1 on this, so an
      // operator who mistyped a uuid is told instead of believing a password was set.
      const { conn } = fakeDb([[]]);
      expect(await new PostgresCredentialStore(conn).setCredential(USER, HASH)).toBe(false);
    });
  });

  it("never sets a tenant context on any statement", async () => {
    // Enforced by the fake, which throws on `set_config`. Both tables are platform-wide with no
    // RLS, and the scoped membership read belongs to `PostgresUserStore.membershipFor`, which
    // already carries the `withTenantContext` and the strict `scopeFilter` its single ALL-scope
    // policy requires. A second spelling of that read is how two of them drift.
    const { conn, sql } = fakeDb([
      [{ id: TENANT, status: "active" }],
      [{ id: USER, status: "active", credential_hash: HASH, credential_failed_attempts: 0 }],
      [{ credential_failed_attempts: 1 }],
      [],
      [{}],
    ]);
    const store = new PostgresCredentialStore(conn);
    await store.resolveTenant("acme");
    await store.findByEmail("a@b.test");
    await store.recordFailure(USER, 3, 30);
    await store.recordSuccess(USER);
    await store.setCredential(USER, HASH);
    expect(sql()).not.toContain("set_config");
    expect(sql()).not.toContain("current_setting");
  });
});
