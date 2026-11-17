import pg from "pg";

import {
  UNBOUNDED_POOL_SETTINGS,
  pgSessionParameters,
  sslModeRequiresTls,
  sslModeValidatesCertificate,
  type ConnectionFactory,
  type PgConfig,
  type PgConnection,
  type PgPoolSettings,
  type PgQueryResult,
} from "./connection.js";

const { Pool } = pg;

interface PgPoolClient {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(err?: Error): void;
  on(event: "error", listener: (err: Error) => void): unknown;
  removeListener(event: "error", listener: (err: Error) => void): unknown;
}

interface PgPool {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/**
 * Every way a pooled connection can fail outside a statement's own promise.
 *
 * Each is something node-postgres hands to an `EventEmitter` with no listener — which Node turns
 * into an uncaught exception that **exits the process** — or something the old code swallowed and
 * then handed the connection back to the pool as if it were sound.
 */
export const PG_POOL_EVENT_KINDS = [
  "idle_client_lost",
  "checked_out_client_lost",
  "rollback_failed",
  "advisory_unlock_failed",
  "session_settings_failed",
] as const;

export type PgPoolEventKind = (typeof PG_POOL_EVENT_KINDS)[number];

export interface PgPoolEvent {
  readonly kind: PgPoolEventKind;
  readonly message: string;
}

export interface NodePgConnectionOptions {
  /** Defaults to {@link UNBOUNDED_POOL_SETTINGS}: no session limit unless a caller chooses one. */
  readonly pool?: PgPoolSettings;
  /** Defaults to one `console.error` line per event. Must not throw. */
  readonly onPoolEvent?: (event: PgPoolEvent) => void;
}

function defaultPoolEventReporter(event: PgPoolEvent): void {
  console.error(`[pg] ${event.kind}: ${event.message}`);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Listen for a connection-level error on a client **while it is checked out**.
 *
 * node-postgres removes the pool's own error listener on checkout and restores it on release, and
 * `pool.query` attaches one for the duration of its single statement — so a client held across
 * awaits by `transaction` or `withAdvisoryLock` has none. A connection lost in that window (a
 * database restart, `idle_in_transaction_session_timeout` firing, a terminated backend) is emitted
 * with no listener and exits the process. The error is recorded so the caller can discard the
 * client rather than return a dead one.
 */
function watchCheckedOut(
  client: PgPoolClient,
  report: (event: PgPoolEvent) => void,
): { readonly lost: () => Error | null; readonly stop: () => void } {
  let lost: Error | null = null;
  const listener = (err: Error): void => {
    lost = err;
    report({ kind: "checked_out_client_lost", message: err.message });
  };
  client.on("error", listener);
  return {
    lost: () => lost,
    stop: () => {
      client.removeListener("error", listener);
    },
  };
}

/**
 * Return a client to the pool, or **destroy** it when anything says its session is not sound.
 *
 * `release(err)` is node-postgres's discard: the client is removed and its socket closed, which
 * also ends every session-scoped thing on it — an advisory lock whose unlock failed, a transaction
 * whose ROLLBACK failed. Handed back with a bare `release()`, the next caller inherits that session.
 */
function releaseClient(client: PgPoolClient, discard: unknown): void {
  if (discard === null || discard === undefined) client.release();
  else client.release(asError(discard));
}

/**
 * Normalizes what node-postgres hands back, including the case it hands back an **array**.
 *
 * A simple query holding more than one statement — `DROP INDEX …; CREATE INDEX …;`, which is how an
 * object is replaced without a window where it is missing — returns one result per statement. Reading
 * `.rows` off the array yields undefined and the caller died with
 * `Cannot read properties of undefined (reading 'length')`, a JS TypeError wearing the costume of a
 * database error. The last result is the one a caller means: for a DDL batch it is the final
 * statement's, and for a batch ending in a SELECT it is the rows.
 */
export function rowsResult<T>(result: unknown): PgQueryResult<T> {
  const last = Array.isArray(result) ? result[result.length - 1] : result;
  if (last === undefined || last === null) return { rows: [], rowCount: 0 };
  const shaped = last as { rows?: unknown[]; rowCount?: number | null };
  const rows = shaped.rows ?? [];
  return {
    rows: rows as readonly T[],
    rowCount: shaped.rowCount ?? rows.length,
  };
}

function wrapClient(client: PgPoolClient): PgConnection {
  return {
    async query<T>(sql: string, params?: readonly unknown[]) {
      return rowsResult<T>(
        await client.query(sql, params === undefined ? undefined : Array.from(params)),
      );
    },
    async transaction() {
      throw new Error("nested transactions are not supported");
    },
    async withAdvisoryLock() {
      throw new Error(
        "withAdvisoryLock must be called on the pool-level connection, not inside a transaction",
      );
    },
    async close() {
      throw new Error("close must be called on the pool-level connection");
    },
  };
}

export function createNodePgConnection(
  config: PgConfig,
  options: NodePgConnectionOptions = {},
): PgConnection {
  const settings = options.pool ?? UNBOUNDED_POOL_SETTINGS;
  const report = options.onPoolEvent ?? defaultPoolEventReporter;
  // Two of the three judgements here were spellings of maps in `connection.ts`, and both are read
  // from them now rather than restated as mode-name comparisons — which is where those two
  // predicates came from: a judgement written here *and* there can disagree about one mode with
  // nothing noticing, and here it gates what node asks of its TLS stack while there it gates what
  // an operator is told at boot.
  //
  //   - *must there be TLS at all* → `sslModeRequiresTls`, the complement of `plaintext_possible`.
  //   - *is the peer checked* → `sslModeValidatesCertificate`, `verify-full` and nothing else.
  //
  // The one mode comparison that stays is `disable`, and it has to: `disable`, `allow` and `prefer`
  // share one assurance (the channel may be plaintext) and differ only in *who declines* — so
  // `disable` passes `ssl: false` and the other two pass nothing and let the server decide, which
  // is the one distinction the assurance deliberately does not carry.
  const sslOption =
    config.ssl === "disable"
      ? false
      : sslModeRequiresTls(config.ssl)
        ? { rejectUnauthorized: sslModeValidatesCertificate(config.ssl) }
        : undefined;
  // The session limits are set by a statement on each new connection rather than as startup
  // parameters: a connection pooler between this process and Postgres (PgBouncer, Supabase's
  // session pooler) may refuse a startup parameter it does not track, which would fail every
  // connection, where a `set_config` is an ordinary statement any session may run. It runs in the
  // pool's `verify` hook, which node-postgres awaits before handing a **new** client to anyone — so
  // the first statement on a connection always runs under the limits, and a connection whose limits
  // could not be set is discarded and its acquire fails, rather than served unbounded. (Issuing it
  // from the `connect` event instead races the acquirer's own statement on one client, which
  // node-postgres warns it will stop supporting.) Values are bound, never spliced.
  const sessionParameters = pgSessionParameters(settings);
  const sessionSql =
    "SELECT " +
    sessionParameters
      .map((p, i) => `set_config('${p.name}', $${String(i + 1)}, false)`)
      .join(", ");
  const sessionValues = sessionParameters.map((p) => `${String(p.valueMs)}ms`);
  const verify =
    sessionParameters.length === 0
      ? undefined
      : (client: PgPoolClient, done: (err?: Error) => void): void => {
          // node-postgres has already removed the pool's listener when it calls `verify`, and a
          // socket that drops mid-statement (a reset, not a server FATAL) is emitted as `error`
          // beside the query's own rejection — so without this, a network blip while a new
          // connection is being limited exits the process. Reproduced through a resetting proxy.
          const watch = watchCheckedOut(client, report);
          client.query(sessionSql, sessionValues).then(
            () => {
              watch.stop();
              const lost = watch.lost();
              if (lost === null) done();
              else done(lost);
            },
            (err: unknown) => {
              watch.stop();
              report({ kind: "session_settings_failed", message: messageOf(err) });
              done(asError(err));
            },
          );
        };
  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    application_name: config.applicationName,
    max: settings.maxConnections,
    connectionTimeoutMillis: settings.connectTimeoutMs,
    idleTimeoutMillis: settings.idleTimeoutMs,
    ...(sslOption !== undefined ? { ssl: sslOption } : {}),
    ...(verify !== undefined ? { verify } : {}),
  }) as unknown as PgPool;

  // An idle pooled client whose connection drops is emitted here, and an `error` event with no
  // listener exits the process — reproduced on PG 16 by terminating an idle backend. The pool has
  // already removed and closed the client by the time this fires, so there is nothing to do but say
  // so; the next query opens a fresh connection.
  pool.on("error", (err) => {
    report({ kind: "idle_client_lost", message: err.message });
  });

  const connection: PgConnection = {
    async query<T>(sql: string, params?: readonly unknown[]) {
      return rowsResult<T>(
        await pool.query(sql, params === undefined ? undefined : Array.from(params)),
      );
    },
    async transaction<T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const watch = watchCheckedOut(client, report);
      let discard: unknown = null;
      try {
        await client.query("BEGIN");
        const result = await fn(wrapClient(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          // The original error is the one the caller needs; the rollback failure decides only that
          // this session must not be reused, since it may still be inside the transaction.
          discard = rollbackErr;
          report({ kind: "rollback_failed", message: messageOf(rollbackErr) });
        }
        throw err;
      } finally {
        watch.stop();
        releaseClient(client, discard ?? watch.lost());
      }
    },
    async withAdvisoryLock<T>(lockKey: bigint, fn: () => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const watch = watchCheckedOut(client, report);
      let discard: unknown = null;
      try {
        await client.query("SELECT pg_advisory_lock($1)", [lockKey.toString()]);
        try {
          return await fn();
        } finally {
          try {
            await client.query("SELECT pg_advisory_unlock($1)", [lockKey.toString()]);
          } catch (unlockErr) {
            // Not rethrown: the work under the lock has already happened, and discarding the
            // session ends it, which releases a session-level advisory lock server-side. Rethrowing
            // would report a completed operation as failed, or replace the error `fn` raised.
            discard = unlockErr;
            report({ kind: "advisory_unlock_failed", message: messageOf(unlockErr) });
          }
        }
      } finally {
        watch.stop();
        releaseClient(client, discard ?? watch.lost());
      }
    },
    async close() {
      await pool.end();
    },
  };

  return connection;
}

export const nodePgConnectionFactory: ConnectionFactory = (config) => createNodePgConnection(config);
