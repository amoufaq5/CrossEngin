import { isoInstant, type PgConnection } from "@crossengin/kernel-pg";

import { normalizeEmail } from "./platform-users.js";

/**
 * The statements password login needs, and nothing else.
 *
 * ## Why these are not `PostgresUserStore`'s statements
 *
 * `USER_COLUMNS` is one constant feeding seven statements -- both `provision` RETURNINGs,
 * `getById`, `getByEmail`, `list` and `transitionStatus` -- and `rowToUser` parses into a
 * `.strict()` `UserRecordSchema`. So adding the credential columns there would have exactly two
 * outcomes, both wrong: without a schema change every registry read throws on the unknown key, and
 * with one the password hash appears in the 200 body of `platform.users.list`, `.get`,
 * `.provision`, `.suspend`, `.reactivate` and `.retire`. A hash is not a field of the user record
 * the registry serves, so it gets its own read naming its own columns.
 *
 * ## Why the reads carry no tenant context
 *
 * `meta.users` has **no `tenant_id`, no RLS and no policies** -- verified against a live catalog --
 * so it is confined by the serving role's table GRANT alone and an unauthenticated route can read
 * it with no principal and no transaction. `meta.tenants` is the same. That is what makes login
 * possible at all, and it is also why `password.ts` peppers: the hash is readable by anything
 * holding the gateway's grant, so a secret the database does not hold is what makes reading the
 * table insufficient.
 *
 * The membership read is deliberately **not** here. `PostgresUserStore.membershipFor` already
 * carries the `withTenantContext` and the strict `scopeFilter` that table's single `ALL`-scope
 * policy requires, and a second spelling of a scoped read is how the two drift.
 */

/** What one lookup by email has to answer before any password work is done. */
export interface CredentialRecord {
  readonly userId: string;
  readonly status: string;
  /** `null` means *this user has no password*, which is not *the password did not match*. */
  readonly credentialHash: string | null;
  readonly failedAttempts: number;
  readonly lockedUntil: string | null;
}

export interface TenantRef {
  readonly tenantId: string;
  readonly status: string;
}

const CREDENTIAL_COLUMNS =
  "id, status, credential_hash, credential_failed_attempts, credential_locked_until";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export interface PostgresCredentialStoreOptions {
  readonly schema?: string;
}

export class PostgresCredentialStore {
  private readonly users: string;
  private readonly tenants: string;

  constructor(
    private readonly conn: PgConnection,
    options: PostgresCredentialStoreOptions = {},
  ) {
    // An options object with `const schema = options.schema ?? "meta"`, which is
    // `PostgresUserStore`'s exact shape and not a stylistic echo of it. `pg-column-coverage`'s
    // scanner resolves a table name by chasing `this.x = `${ident}.tbl`` back to a literal, and it
    // reads `options.schema ?? "meta"` and a `const` but **not a parameter default** -- so the
    // obvious `constructor(conn, schema = "meta")` leaves every statement in this file an
    // `unresolved_target`, which means the rule checks none of this store's SQL against the
    // catalog. The validation is identical either way; where the name comes from decides whether
    // the columns are verified at all.
    const schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.users = `${schema}.users`;
    this.tenants = `${schema}.tenants`;
  }

  /**
   * Resolves the tenant the login names, by slug or by id.
   *
   * The caller must name one, because `membershipFor` requires a tenant and `platform-users.ts`
   * deliberately refuses a by-user membership read -- *"that read has no scope to name, so it would
   * be owner-dependent by construction"*. So login by email alone cannot enumerate a user's
   * tenants, and the honest answer is to respect that refusal rather than add the read it declined.
   *
   * Both spellings resolve through one statement rather than a branch, so a slug that happens to
   * look like a UUID cannot take a different path than the one the operator meant. `slug` and `id`
   * are both unique, so at most one row matches either way.
   */
  async resolveTenant(ref: string): Promise<TenantRef | null> {
    const trimmed = ref.trim();
    if (trimmed === "") return null;
    const asUuid = UUID_RE.test(trimmed) ? trimmed.toLowerCase() : null;
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT id, status FROM ${this.tenants}` +
        " WHERE slug = $1 OR ($2::uuid IS NOT NULL AND id = $2::uuid) LIMIT 1",
      [trimmed, asUuid],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { tenantId: String(row["id"]), status: String(row["status"]) };
  }

  /**
   * One round trip for everything the password check needs: who this is, whether they are
   * suspended, what to verify against, and whether they are locked out.
   *
   * `null` for an unknown email. The caller must then spend a derivation's worth of work anyway
   * (`spendPasswordWork`) -- returning early is what turns a login route into an account
   * enumerator, because an unknown email would answer in under a millisecond against ~130 ms for
   * a real one.
   */
  async findByEmail(email: string): Promise<CredentialRecord | null> {
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${CREDENTIAL_COLUMNS} FROM ${this.users} WHERE email = $1`,
      [normalizeEmail(email)],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const hash = row["credential_hash"];
    const locked = row["credential_locked_until"];
    return {
      userId: String(row["id"]),
      status: String(row["status"]),
      credentialHash: typeof hash === "string" && hash !== "" ? hash : null,
      failedAttempts: Number(row["credential_failed_attempts"] ?? 0),
      lockedUntil: locked === null || locked === undefined ? null : isoInstant(locked),
    };
  }

  /**
   * The same row by id rather than by email, for a caller that already knows who it is talking to.
   *
   * Both credential routes need this and neither can use `findByEmail`: the self-service change
   * identifies its subject from `principal.principalId`, which *is* `meta.users.id`, and asking
   * the caller for their email to look up the row they are already authenticated as would make the
   * subject a request field -- which is the one thing that route must not have.
   *
   * There is deliberately **no** `spendPasswordWork` obligation on a miss here, which is the one
   * way this differs from its sibling. `findByEmail` is reached by an unauthenticated login where
   * an early return is an account enumerator; every caller of this one is already past the auth
   * stage and is naming its own id or one it holds a grant over, so there is nothing to enumerate
   * and a constant-time miss would buy nothing.
   */
  async findById(userId: string): Promise<CredentialRecord | null> {
    if (!UUID_RE.test(userId.trim())) return null;
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${CREDENTIAL_COLUMNS} FROM ${this.users} WHERE id = $1::uuid`,
      [userId.trim().toLowerCase()],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const hash = row["credential_hash"];
    const locked = row["credential_locked_until"];
    return {
      userId: String(row["id"]),
      status: String(row["status"]),
      credentialHash: typeof hash === "string" && hash !== "" ? hash : null,
      failedAttempts: Number(row["credential_failed_attempts"] ?? 0),
      lockedUntil: locked === null || locked === undefined ? null : isoInstant(locked),
    };
  }

  /**
   * Advances the failure counter and locks the account when it crosses the threshold, in **one**
   * statement.
   *
   * Read-modify-write is what this must not be: the losing side of that race is the one that
   * *admits* an attempt, so two concurrent wrong guesses would each read the same count and each
   * write it plus one -- advancing by one where two attempts happened. That is
   * `meta.notification_fax_observations`' reasoning (ADR-0332) about a counter whose whole job is
   * to stop something, and it is why the arithmetic is in SQL and the threshold is a parameter
   * rather than a branch in TypeScript.
   *
   * The lock is set from the database clock and not the process's, for the same reason the
   * kill-switch active predicate uses it: a drifted worker must not unlock an account early.
   */
  async recordFailure(
    userId: string,
    lockAfterAttempts: number,
    lockSeconds: number,
  ): Promise<{ readonly failedAttempts: number; readonly lockedUntil: string | null }> {
    const result = await this.conn.query<Record<string, unknown>>(
      `UPDATE ${this.users} SET` +
        " credential_failed_attempts = credential_failed_attempts + 1," +
        " credential_locked_until = CASE" +
        "   WHEN credential_failed_attempts + 1 >= $2 THEN now() + make_interval(secs => $3)" +
        "   ELSE credential_locked_until END," +
        " updated_at = now()" +
        " WHERE id = $1::uuid" +
        " RETURNING credential_failed_attempts, credential_locked_until",
      [userId, lockAfterAttempts, lockSeconds],
    );
    const row = result.rows[0];
    if (row === undefined) return { failedAttempts: 0, lockedUntil: null };
    const locked = row["credential_locked_until"];
    return {
      failedAttempts: Number(row["credential_failed_attempts"] ?? 0),
      lockedUntil: locked === null || locked === undefined ? null : isoInstant(locked),
    };
  }

  /**
   * Clears the counter and the lock and stamps `last_login_at`.
   *
   * `last_login_at` has been declared since Phase 1, is read by `access-reviews`' dormancy
   * predicate, and was written by **nothing** -- so today every principal reads as dormant and
   * nobody has noticed. This is its first writer, which means a deployment that runs an access
   * review campaign will see its item generation change. That is a consequence worth stating
   * rather than a bug: the predicate was always meant to read a real figure.
   */
  async recordSuccess(userId: string): Promise<void> {
    await this.conn.query(
      `UPDATE ${this.users} SET credential_failed_attempts = 0,` +
        " credential_locked_until = NULL, last_login_at = now(), updated_at = now()" +
        " WHERE id = $1::uuid",
      [userId],
    );
  }

  /**
   * Sets or replaces a user's password hash, clearing any lock.
   *
   * Takes the already-encoded hash -- this module does no hashing, so a caller cannot accidentally
   * store a plaintext password by passing the wrong argument, and the column's CHECK would refuse
   * it `23514` anyway, which is a worse place to learn it than not being able to express it. The
   * parameter is named for the **column** and not for that property (`credentialHash`, not
   * `encodedHash`), because `pg-binding-names.ts` compares the two and agreement is this repo's
   * norm; the fact that it is encoded is stated here, where a reader looks, rather than in a
   * declaration somebody would have to re-verify.
   *
   * Returns whether a row matched, so a caller naming a user who does not exist is told rather
   * than reporting a success it did not have.
   */
  async setCredential(userId: string, credentialHash: string): Promise<boolean> {
    const result = await this.conn.query(
      `UPDATE ${this.users} SET credential_hash = $2, credential_updated_at = now(),` +
        " credential_failed_attempts = 0, credential_locked_until = NULL, updated_at = now()" +
        " WHERE id = $1::uuid",
      [userId, credentialHash],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
