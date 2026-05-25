import pg from "pg";

import {
  type ConnectionFactory,
  type PgConfig,
  type PgConnection,
  type PgQueryResult,
} from "./connection.js";

const { Pool } = pg;

interface PgPoolClient {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(): void;
}

interface PgPool {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
}

function rowsResult<T>(result: { rows: unknown[]; rowCount: number | null }): PgQueryResult<T> {
  return {
    rows: result.rows as readonly T[],
    rowCount: result.rowCount ?? result.rows.length,
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

export function createNodePgConnection(config: PgConfig): PgConnection {
  const sslOption =
    config.ssl === "disable"
      ? false
      : config.ssl === "require" || config.ssl === "verify-ca" || config.ssl === "verify-full"
        ? { rejectUnauthorized: config.ssl === "verify-full" }
        : undefined;
  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    application_name: config.applicationName,
    ...(sslOption !== undefined ? { ssl: sslOption } : {}),
  }) as unknown as PgPool;

  const connection: PgConnection = {
    async query<T>(sql: string, params?: readonly unknown[]) {
      return rowsResult<T>(
        await pool.query(sql, params === undefined ? undefined : Array.from(params)),
      );
    },
    async transaction<T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrapClient(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Roll-back failure during error handling is best-effort.
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async withAdvisoryLock<T>(lockKey: bigint, fn: () => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("SELECT pg_advisory_lock($1)", [lockKey.toString()]);
        try {
          return await fn();
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [lockKey.toString()]);
        }
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };

  return connection;
}

export const nodePgConnectionFactory: ConnectionFactory = createNodePgConnection;
