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
            session_epoch: 3,
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
        sessionEpoch: 3,
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

  describe("findById", () => {
    it("reads the same columns as its sibling, by id", async () => {
      // One `CREDENTIAL_COLUMNS` behind both, so the two cannot come to disagree about which
      // fields a credential record has -- the asymmetry between them is the *obligation on a
      // miss*, not the projection.
      const { conn, captured } = fakeDb([
        [
          {
            id: USER,
            status: "suspended",
            credential_hash: HASH,
            credential_failed_attempts: 4,
            credential_locked_until: null,
          },
        ],
      ]);
      expect(await new PostgresCredentialStore(conn).findById(USER)).toEqual({
        userId: USER,
        status: "suspended",
        credentialHash: HASH,
        failedAttempts: 4,
        lockedUntil: null,
        sessionEpoch: 0,
      });
      const sql = captured[0]!.sql;
      expect(sql).toContain("credential_hash");
      expect(sql).toContain("credential_failed_attempts");
      expect(sql).toContain("credential_locked_until");
      expect(sql).toContain("WHERE id = $1::uuid");
      // `email` and not `lower(email)`: normalisation happens in `normalizeEmail` rather than in
      // SQL, so the sibling statement is `WHERE email = $1` and an exclusion written over
      // `lower(email)` passes for the exact statement it exists to rule out.
      expect(sql).not.toContain("email");
      expect(sql).not.toContain("display_name");
    });

    it("answers null for a non-uuid without issuing a statement", async () => {
      // `::uuid` raises `22P02` on a malformed value, and the operator route turns this null into
      // its own 400 -- so a mistyped path segment is a refusal rather than a 500 from the driver.
      const { conn, captured } = fakeDb([[{ id: USER }]]);
      const store = new PostgresCredentialStore(conn);
      expect(await store.findById("not-a-uuid")).toBeNull();
      expect(await store.findById("")).toBeNull();
      expect(await store.findById("   ")).toBeNull();
      expect(captured).toHaveLength(0);
    });

    it("lowercases and trims the id it binds", async () => {
      // `USER` and `TENANT` are digits and dashes, so `.toUpperCase()` on either is the IDENTITY
      // and an assertion written over one proves the trim and nothing about the case — it passes
      // with `.toLowerCase()` deleted from the implementation. (`resolveTenant`'s sibling test at
      // the top of this file is vacuous for exactly that reason.) So the case-folding half needs a
      // uuid that carries hex letters, which is what makes it observable at all.
      const MIXED = "AB12CD34-56EF-4A78-9BCD-EF0123456789";
      const { conn, captured } = fakeDb([[], [{ id: MIXED.toLowerCase(), status: "active" }]]);
      const store = new PostgresCredentialStore(conn);
      await store.findById(`  ${USER}  `);
      expect(captured[0]!.params).toEqual([USER]);
      const record = await store.findById(`  ${MIXED}  `);
      expect(captured[1]!.params).toEqual([MIXED.toLowerCase()]);
      expect(record?.userId).toBe(MIXED.toLowerCase());
    });

    it("carries no tenant context and no scope predicate", async () => {
      // The deliberate exception to the scoped-read rule rather than an omission: `meta.users` has
      // no `tenant_id`, no RLS and no policies — verified against a live catalog — so it is
      // confined by the serving role's table GRANT alone, and there is no scope for this read to
      // name. Naming one would be a second spelling of `PostgresUserStore.membershipFor`'s scoped
      // read, which that module's own comment says is how two of them drift. Asserted at the read
      // it is about as well as in the file-wide sweep below, so the property is stated where it
      // holds: the sweep proves no statement sets a context, and this proves it of *this* one,
      // which is the assertion that survives a method being dropped from the sweep's list.
      const { conn, captured, sql } = fakeDb([
        [{ id: USER, status: "active", credential_hash: HASH, credential_failed_attempts: 0 }],
      ]);
      await new PostgresCredentialStore(conn).findById(USER);
      expect(captured).toHaveLength(1);
      expect(sql()).not.toContain("set_config");
      expect(sql()).not.toContain("current_setting");
      expect(captured[0]!.sql).not.toContain("tenant_id");
    });

    it("reads an absent or empty hash as null, so no-credential is distinguishable", async () => {
      // A provisioned user holds no credential until one is set, and `no_current_credential` is a
      // different refusal from `current_password_wrong` -- so the empty string must not read as a
      // hash nobody can match (ADR-0331's claim-versus-nobody-looked, inside a 409 vs a 401).
      const { conn } = fakeDb([
        [{ id: USER, status: "active", credential_hash: "", credential_failed_attempts: 0 }],
        [{ id: USER, status: "active", credential_failed_attempts: 0 }],
      ]);
      const store = new PostgresCredentialStore(conn);
      expect((await store.findById(USER))?.credentialHash).toBeNull();
      expect((await store.findById(USER))?.credentialHash).toBeNull();
    });

    it("normalizes a Date lock to an ISO instant", async () => {
      // node-postgres answers a TIMESTAMPTZ as a `Date` and Postgres refuses to parse its own
      // `Date.toString()` (ADR-0331), so the normaliser is not cosmetic.
      const { conn } = fakeDb([
        [
          {
            id: USER,
            status: "active",
            credential_hash: HASH,
            credential_failed_attempts: 1,
            credential_locked_until: new Date("2026-10-11T12:00:00.000Z"),
          },
        ],
      ]);
      expect((await new PostgresCredentialStore(conn).findById(USER))?.lockedUntil).toBe(
        "2026-10-11T12:00:00.000Z",
      );
    });

    it("answers null for a well-formed id with no row", async () => {
      const { conn } = fakeDb([[]]);
      expect(await new PostgresCredentialStore(conn).findById(USER)).toBeNull();
    });
  });

  describe("reserveAttempt", () => {
    it("counts the attempt and locks in ONE statement, reading the clock from the database", async () => {
      // Read-modify-write is what this must not be: the losing side of that race ADMITS an
      // attempt. And the lock comes from `now()`, so a drifted worker cannot unlock early.
      const { conn, captured } = fakeDb([
        [{ credential_failed_attempts: 10, credential_locked_until: "2026-10-11T12:15:00.000Z" }],
      ]);
      const r = await new PostgresCredentialStore(conn).reserveAttempt(USER, 10, 900);
      expect(r).toEqual({
        reserved: true,
        failedAttempts: 10,
        lockedUntil: "2026-10-11T12:15:00.000Z",
      });
      expect(captured).toHaveLength(1);
      const sql = captured[0]!.sql;
      expect(sql).toMatch(/^UPDATE meta\.users SET/);
      expect(sql).toContain("now() + make_interval");
      expect(sql).toContain("RETURNING");
      expect(captured[0]!.params).toEqual([USER, 10, 900]);
    });

    it("admits a row only while it is unlocked, which is what bounds concurrent guesses", async () => {
      // The whole parallel-bypass fix is this predicate: a concurrent UPDATE re-checks it against
      // the row the earlier one committed, so once the threshold-th reservation sets the lock every
      // later one matches nothing and is never evaluated.
      const { conn, captured } = fakeDb([[]]);
      await new PostgresCredentialStore(conn).reserveAttempt(USER, 10, 900);
      expect(captured[0]!.sql).toContain(
        "AND (credential_locked_until IS NULL OR credential_locked_until <= now())",
      );
    });

    it("restarts the count at 1 when the previous lock has expired, rather than continuing it", async () => {
      // Continuing it was the persistent re-lock: the count never fell below the threshold, so one
      // wrong guess after the window lapsed re-locked the account, for ever.
      const { conn, captured } = fakeDb([[]]);
      await new PostgresCredentialStore(conn).reserveAttempt(USER, 10, 900);
      const sql = captured[0]!.sql;
      const next =
        "CASE WHEN credential_locked_until IS NULL THEN credential_failed_attempts + 1 ELSE 1 END";
      expect(sql).toContain(`credential_failed_attempts = ${next}`);
      // The threshold is compared against the POST-increment value, or the lock lands one attempt
      // late and the configured figure means something other than what it says.
      expect(sql).toContain(`WHEN ${next} >= $2`);
      // An expired lock is cleared when the new window does not reach the threshold.
      expect(sql).toContain("ELSE NULL END");
    });

    it("answers not-reserved when no row matched (locked, or gone)", async () => {
      const { conn } = fakeDb([[]]);
      expect(await new PostgresCredentialStore(conn).reserveAttempt(USER, 3, 30)).toEqual({
        reserved: false,
      });
    });

    it("reports no lock below the threshold", async () => {
      const { conn } = fakeDb([[{ credential_failed_attempts: 1, credential_locked_until: null }]]);
      expect(await new PostgresCredentialStore(conn).reserveAttempt(USER, 3, 30)).toEqual({
        reserved: true,
        failedAttempts: 1,
        lockedUntil: null,
      });
    });
  });

  describe("releaseAttempt", () => {
    it("gives one back, never below zero, and lifts the lock only below the threshold", async () => {
      const { conn, captured } = fakeDb([[]]);
      await new PostgresCredentialStore(conn).releaseAttempt(USER, 10);
      const sql = captured[0]!.sql;
      expect(sql).toContain("credential_failed_attempts = GREATEST(credential_failed_attempts - 1, 0)");
      expect(sql).toContain(
        "credential_locked_until = CASE WHEN credential_failed_attempts - 1 < $2 THEN NULL ELSE credential_locked_until END",
      );
      expect(captured[0]!.params).toEqual([USER, 10]);
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

    it("ends every session in the same statement", async () => {
      // A password set is the moment sessions minted under the previous one must stop working; a
      // second statement could land between two requests that would then disagree.
      const { conn, captured } = fakeDb([[{}]]);
      await new PostgresCredentialStore(conn).setCredential(USER, HASH);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.sql).toContain("session_epoch = session_epoch + 1");
    });

    it("reports false for a user that does not exist", async () => {
      // Rather than reporting a success it did not have: `set-credential` exits 1 on this, so an
      // operator who mistyped a uuid is told instead of believing a password was set.
      const { conn } = fakeDb([[]]);
      expect(await new PostgresCredentialStore(conn).setCredential(USER, HASH)).toBe(false);
    });
  });

  describe("rehashCredential", () => {
    it("ends no session and is conditional on the hash it replaces", async () => {
      const { conn, captured } = fakeDb([[{}]]);
      const next = HASH.replace("$1$", "$3$");
      expect(await new PostgresCredentialStore(conn).rehashCredential(USER, HASH, next)).toBe(true);
      const sql = captured[0]!.sql;
      // A re-hash is the same password under new parameters, not a password change.
      expect(sql).not.toContain("session_epoch");
      expect(sql).toContain("credential_hash = $3");
      expect(sql).toContain("AND credential_hash = $2");
      expect(captured[0]!.params).toEqual([USER, HASH, next]);
    });

    it("reports false when the hash moved underneath it", async () => {
      // A password change that landed between the login's verification and this write: the
      // re-hash of the old password must not overwrite the new one.
      const { conn } = fakeDb([[]]);
      expect(await new PostgresCredentialStore(conn).rehashCredential(USER, HASH, HASH)).toBe(false);
    });
  });

  describe("endSessions", () => {
    it("advances the generation and answers the new one", async () => {
      const { conn, captured } = fakeDb([[{ session_epoch: 4 }]]);
      expect(await new PostgresCredentialStore(conn).endSessions(USER)).toBe(4);
      expect(captured[0]!.sql).toContain("session_epoch = session_epoch + 1");
      expect(captured[0]!.sql).toContain("RETURNING session_epoch");
      expect(captured[0]!.params).toEqual([USER]);
    });

    it("answers null for a user that does not exist", async () => {
      const { conn } = fakeDb([[]]);
      expect(await new PostgresCredentialStore(conn).endSessions(USER)).toBeNull();
    });
  });

  describe("sessionStanding", () => {
    it("reads status and generation and never the hash", async () => {
      const { conn, captured } = fakeDb([[{ status: "suspended", session_epoch: 2 }]]);
      expect(await new PostgresCredentialStore(conn).sessionStanding(USER)).toEqual({
        status: "suspended",
        sessionEpoch: 2,
      });
      expect(captured[0]!.sql).toBe("SELECT status, session_epoch FROM meta.users WHERE id = $1::uuid");
    });

    it("answers null for a non-uuid without a statement, and for no row", async () => {
      const a = fakeDb([]);
      expect(await new PostgresCredentialStore(a.conn).sessionStanding("nope")).toBeNull();
      expect(a.captured).toHaveLength(0);
      const b = fakeDb([[]]);
      expect(await new PostgresCredentialStore(b.conn).sessionStanding(USER)).toBeNull();
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
      [{ id: USER, status: "active", credential_hash: HASH, credential_failed_attempts: 0 }],
      [{ credential_failed_attempts: 1 }],
      [],
      [],
      [{}],
    ]);
    const store = new PostgresCredentialStore(conn);
    await store.resolveTenant("acme");
    await store.findByEmail("a@b.test");
    await store.findById(USER);
    await store.reserveAttempt(USER, 3, 30);
    await store.releaseAttempt(USER, 3);
    await store.recordSuccess(USER);
    await store.setCredential(USER, HASH);
    expect(sql()).not.toContain("set_config");
    expect(sql()).not.toContain("current_setting");
  });
});
