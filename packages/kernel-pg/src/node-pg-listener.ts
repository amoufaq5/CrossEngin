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

export interface PgNotificationClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  on(event: "notification", listener: (msg: PgNotification) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "end", listener: () => void): void;
  end(): Promise<void>;
}

/** Injectable timer pair so a test can drive backoff with a fake clock. */
export interface ListenerScheduler {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realScheduler: ListenerScheduler = {
  setTimeout(handler, ms) {
    const handle = setTimeout(handler, ms);
    // Never hold the process open on the pending reconnect timer.
    if (typeof (handle as { unref?: () => void }).unref === "function") {
      (handle as { unref: () => void }).unref();
    }
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const BACKOFF_BASE_MS = 1000;
const BACKOFF_FACTOR = 2;
const BACKOFF_CAP_MS = 30000;

export interface ReconnectingListenerOptions {
  readonly onError?: (err: Error) => void;
  readonly onReconnect?: (attempt: number) => void;
  readonly scheduler?: ListenerScheduler;
}

interface Subscription {
  readonly channel: string;
  readonly onNotify: (payload: string) => void;
}

function sslFor(config: PgConfig): false | { rejectUnauthorized: boolean } | undefined {
  if (config.ssl === "disable") return false;
  if (config.ssl === "require" || config.ssl === "verify-ca" || config.ssl === "verify-full") {
    return { rejectUnauthorized: config.ssl === "verify-full" };
  }
  return undefined;
}

/**
 * Builds a resilient `PgListener` over an injected client factory. Each
 * (re)connection mints a FRESH client via `makeClient`, so a dropped socket
 * never leaves stale listeners attached. On a client `error` or `end` (while not
 * intentionally closed) it schedules a reconnect with exponential backoff (base
 * 1s, factor 2, cap 30s; reset to base after a successful connect), re-LISTENs
 * every tracked channel, and re-attaches the single dispatcher that routes a
 * notification to the right `onNotify`. `createNodePgListener` wraps this with a
 * real-`pg.Client` factory; the factory seam keeps tests off a real database.
 */
export function createReconnectingPgListener(
  makeClient: () => PgNotificationClient,
  opts: ReconnectingListenerOptions = {},
): PgListener {
  const scheduler = opts.scheduler ?? realScheduler;
  const subscriptions: Subscription[] = [];

  let client: PgNotificationClient | null = null;
  let closed = false;
  let connecting = false;
  let reconnectTimer: unknown = null;
  let backoffMs = BACKOFF_BASE_MS;
  let reconnectAttempt = 0;

  function dispatch(msg: PgNotification): void {
    if (typeof msg.payload !== "string") return;
    for (const sub of subscriptions) {
      if (sub.channel === msg.channel) sub.onNotify(msg.payload);
    }
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== null) return;
    const delay = backoffMs;
    reconnectTimer = scheduler.setTimeout(() => {
      reconnectTimer = null;
      void reconnect();
    }, delay);
    backoffMs = Math.min(backoffMs * BACKOFF_FACTOR, BACKOFF_CAP_MS);
  }

  function handleClientFailure(err?: Error): void {
    if (err !== undefined && opts.onError !== undefined) opts.onError(err);
    if (closed) return;
    client = null;
    scheduleReconnect();
  }

  async function connect(): Promise<void> {
    if (closed) return;
    connecting = true;
    try {
      const fresh = makeClient();
      fresh.on("error", (err: Error) => handleClientFailure(err));
      fresh.on("end", () => handleClientFailure());
      fresh.on("notification", dispatch);
      await fresh.connect();
      for (const sub of subscriptions) {
        await fresh.query(`LISTEN ${sub.channel}`);
      }
      client = fresh;
      backoffMs = BACKOFF_BASE_MS;
    } finally {
      connecting = false;
    }
  }

  async function reconnect(): Promise<void> {
    if (closed) return;
    reconnectAttempt += 1;
    try {
      await connect();
      if (opts.onReconnect !== undefined) opts.onReconnect(reconnectAttempt);
    } catch (err) {
      if (opts.onError !== undefined) opts.onError(err instanceof Error ? err : new Error(String(err)));
      if (!closed) scheduleReconnect();
    }
  }

  return {
    async listen(channel: string, onNotify: (payload: string) => void): Promise<void> {
      if (!CHANNEL_RE.test(channel)) throw new Error(`invalid LISTEN channel: ${channel}`);
      subscriptions.push({ channel, onNotify });
      if (client === null && !connecting) {
        await connect();
      } else if (client !== null) {
        await client.query(`LISTEN ${channel}`);
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (reconnectTimer !== null) {
        scheduler.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const current = client;
      client = null;
      if (current !== null) await current.end();
    },
  };
}

/**
 * Builds a resilient `PgListener` over a dedicated `pg.Client`. `opts.onError`
 * routes a connection-level error (e.g. the listener socket dropping);
 * `opts.onReconnect` fires when a reconnect succeeds. The listener auto-reconnects
 * with exponential backoff (base 1s, factor 2, cap 30s) and re-LISTENs every
 * tracked channel on the fresh client.
 */
export function createNodePgListener(
  config: PgConfig,
  opts: ReconnectingListenerOptions = {},
): PgListener {
  const ssl = sslFor(config);
  const makeClient = (): PgNotificationClient =>
    new Client({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      application_name: `${config.applicationName}-listener`,
      ...(ssl !== undefined ? { ssl } : {}),
    }) as unknown as PgNotificationClient;
  return createReconnectingPgListener(makeClient, opts);
}
