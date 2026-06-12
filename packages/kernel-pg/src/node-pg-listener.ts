import pg from "pg";

import { type PgConfig } from "./connection.js";

const { Client } = pg;

/**
 * A long-lived Postgres `LISTEN` session. Unlike a pooled query, a notification
 * listener needs a dedicated connection held open for the lifetime of the
 * subscription (LISTEN is connection-scoped), so this wraps a single `pg.Client`
 * rather than the pool-backed `PgConnection`. The publish side (`pg_notify`)
 * needs no special connection and runs through the ordinary `PgConnection`.
 */
export interface PgListener {
  /** Opens the connection (once) and routes each NOTIFY payload on `channel` to `onNotify`. */
  listen(channel: string, onNotify: (payload: string) => void): Promise<void>;
  close(): Promise<void>;
}

/** Postgres identifier shape — a LISTEN channel can't be parameterized, so it's validated then embedded. */
const CHANNEL_RE = /^[a-z_][a-z0-9_]*$/;

interface PgNotification {
  readonly channel: string;
  readonly payload?: string;
}

interface PgNotificationClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  on(event: "notification", listener: (msg: PgNotification) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  end(): Promise<void>;
}

function sslFor(config: PgConfig): false | { rejectUnauthorized: boolean } | undefined {
  if (config.ssl === "disable") return false;
  if (config.ssl === "require" || config.ssl === "verify-ca" || config.ssl === "verify-full") {
    return { rejectUnauthorized: config.ssl === "verify-full" };
  }
  return undefined;
}

/**
 * Builds a `PgListener` over a dedicated `pg.Client`. `opts.onError` routes a
 * connection-level error (e.g. the listener socket dropping) so the caller can
 * log / re-subscribe; the listener does not auto-reconnect.
 */
export function createNodePgListener(
  config: PgConfig,
  opts: { readonly onError?: (err: Error) => void } = {},
): PgListener {
  const ssl = sslFor(config);
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    application_name: `${config.applicationName}-listener`,
    ...(ssl !== undefined ? { ssl } : {}),
  }) as unknown as PgNotificationClient;

  let connected = false;
  return {
    async listen(channel: string, onNotify: (payload: string) => void): Promise<void> {
      if (!CHANNEL_RE.test(channel)) throw new Error(`invalid LISTEN channel: ${channel}`);
      if (!connected) {
        if (opts.onError !== undefined) client.on("error", opts.onError);
        await client.connect();
        connected = true;
      }
      client.on("notification", (msg: PgNotification) => {
        if (msg.channel === channel && typeof msg.payload === "string") onNotify(msg.payload);
      });
      await client.query(`LISTEN ${channel}`);
    },
    async close(): Promise<void> {
      if (connected) {
        await client.end();
        connected = false;
      }
    },
  };
}
