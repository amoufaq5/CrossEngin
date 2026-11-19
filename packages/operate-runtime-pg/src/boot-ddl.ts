import { quoteIdent } from "@crossengin/kernel/ddl";
import {
  DEFAULT_LOCK_RETRIES,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  applyStatementStop,
  type PgConnection,
} from "@crossengin/kernel-pg";

import { MILLISECOND_NOW_SQL, TENANT_ISOLATION_PREDICATE } from "./entity-ddl.js";

/**
 * How the column store applies its DDL at boot: each statement in its own short transaction under
 * `SET LOCAL lock_timeout` and `statement_timeout`, a lock timeout retried with backoff, and a new
 * lookup index built `CONCURRENTLY` — `kernel-pg`'s applier idiom (ADR-0438), for the one DDL path
 * that did not have it.
 *
 * Before this, `ensureSchema` issued every statement bare on the pool, so a statement waiting for a
 * lock held by one long transaction on a busy table waited indefinitely, and every query on that
 * table queued behind the waiting `ACCESS EXCLUSIVE` request — a boot that stalled the deployment
 * it was booting. A statement stopped by the lock timeout rolled back having changed nothing.
 */

export interface BootDdlOptions {
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly lockRetries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One statement, transactional and bounded, with a lock timeout retried `lockRetries` times. */
export async function applyBootStatement(
  conn: PgConnection,
  sql: string,
  opts: BootDdlOptions = {},
): Promise<number> {
  const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const statementTimeoutMs = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const retries = opts.lockRetries ?? DEFAULT_LOCK_RETRIES;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      await conn.transaction(async (tx) => {
        await tx.query(`SET LOCAL lock_timeout = '${String(lockTimeoutMs)}ms'`);
        await tx.query(`SET LOCAL statement_timeout = '${String(statementTimeoutMs)}ms'`);
        await tx.query(sql);
      });
      return attempt;
    } catch (err) {
      if (applyStatementStop(err) !== "lock_timeout" || attempt > retries) throw err;
      await sleep(1_000 * 2 ** (attempt - 1));
    }
  }
}

const CREATE_INDEX_PREFIX = "CREATE INDEX IF NOT EXISTS ";

/**
 * Builds one non-unique index `CONCURRENTLY`, so writes to a populated table go on while it builds.
 * A failed concurrent build leaves an **invalid** index of that name, which `IF NOT EXISTS` would
 * then accept for ever; so an invalid one is dropped first and rebuilt, and a valid one is left
 * alone without issuing the `CREATE` at all — which matters to a role that does not own the table,
 * since Postgres checks ownership before existence. Unique indexes are not built this way: an
 * invalid unique index still refuses duplicate writes while serving no read, which would turn a
 * reported refusal into a silent one.
 *
 * Answers whether it built anything.
 */
export async function applyIndexConcurrently(
  conn: PgConnection,
  index: { readonly qualifiedName: string; readonly sql: string },
): Promise<boolean> {
  if (!index.sql.startsWith(CREATE_INDEX_PREFIX)) {
    throw new Error(`not a non-unique CREATE INDEX IF NOT EXISTS: ${index.sql}`);
  }
  const valid = await indexValidity(conn, index.qualifiedName);
  if (valid === true) return false;
  if (valid === false) await conn.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.qualifiedName};`);
  await conn.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index.sql.slice(CREATE_INDEX_PREFIX.length)}`);
  return true;
}

/** `true` valid and ready, `false` present and not, `null` absent. */
export async function indexValidity(conn: PgConnection, qualifiedName: string): Promise<boolean | null> {
  const res = await conn.query<{ readonly valid: boolean }>(
    `SELECT (x.indisvalid AND x.indisready) AS valid FROM pg_index x WHERE x.indexrelid = to_regclass($1)`,
    [qualifiedName],
  );
  return res.rows[0]?.valid ?? null;
}

/**
 * How this server renders the isolation predicate as a stored policy — `pg_get_expr` of a policy
 * carrying it on a scratch temporary table, dropped at commit. Asked of Postgres rather than
 * spelled, because a policy is compared by its deparse (`::text` casts, parentheses) and the
 * deparse is Postgres's to produce. `null` when it cannot be asked (no `TEMP` privilege), and the
 * caller then replaces each policy rather than comparing it.
 */
export async function renderTenantIsolationQual(conn: PgConnection): Promise<string | null> {
  try {
    return await conn.transaction(async (tx) => {
      const table = quoteIdent("ce_isolation_render");
      await tx.query(`CREATE TEMP TABLE ${table} (tenant_id UUID) ON COMMIT DROP`);
      await tx.query(`CREATE POLICY ${quoteIdent("ce_isolation_render")} ON ${table} USING (${TENANT_ISOLATION_PREDICATE})`);
      const res = await tx.query<{ readonly qual: string | null }>(
        `SELECT pg_get_expr(p.polqual, p.polrelid) AS qual FROM pg_policy p WHERE p.polrelid = 'pg_temp.ce_isolation_render'::regclass`,
      );
      return res.rows[0]?.qual ?? null;
    });
  } catch {
    return null;
  }
}

/**
 * How this server stores the system timestamps' millisecond default — `pg_get_expr` of a column
 * carrying it on a scratch temporary table — so the guarded `SET DEFAULT` compares against
 * Postgres's deparse and not this source text. `null` when it cannot be asked, and the `SET
 * DEFAULT` then runs on every application as it always did.
 */
export async function renderMillisecondNowDefault(conn: PgConnection): Promise<string | null> {
  try {
    return await conn.transaction(async (tx) => {
      const table = quoteIdent("ce_default_render");
      await tx.query(
        `CREATE TEMP TABLE ${table} (t TIMESTAMPTZ DEFAULT ${MILLISECOND_NOW_SQL}) ON COMMIT DROP`,
      );
      const res = await tx.query<{ readonly expr: string | null }>(
        `SELECT pg_get_expr(d.adbin, d.adrelid) AS expr FROM pg_attrdef d WHERE d.adrelid = 'pg_temp.ce_default_render'::regclass`,
      );
      return res.rows[0]?.expr ?? null;
    });
  } catch {
    return null;
  }
}
