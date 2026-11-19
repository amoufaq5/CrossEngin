/**
 * The HTTP listener's own bounds, and the shutdown that honours them.
 *
 * Node 22 does have listener timeouts — `headersTimeout` 60 s and `requestTimeout` 300 s, measured on
 * v22.23.4 — so "the listener has no timeouts" is not true of this binary. What it did not have is
 * a connection cap (`maxConnections` is `undefined`, i.e. unlimited), a keep-alive timeout chosen
 * against the proxy in front of it, or any way to set the four from a deployment. And its shutdown
 * stopped every scheduler and then called `server.close()` with no bound on how long the requests
 * still running may take, and left the Postgres pool open. (Node 22's `close()` does close the
 * sockets idle *at that moment*; a request that finishes afterwards leaves its socket idle in
 * keep-alive and nothing closes it — see `closeListener`.)
 *
 * The keep-alive default is the one value deliberately different from Node's. Node closes an idle
 * socket after 5 s; Caddy's `reverse_proxy` keeps an idle upstream connection for 2 minutes (its
 * documented default, not measured here), so it can choose to reuse a socket Node is closing at that
 * moment, and the request on it fails as a 502 at the edge. An upstream's keep-alive must outlast
 * the proxy's, so 125 s.
 */

/** The listener settings a deployment can set. All in milliseconds except the connection cap. */
export interface HttpListenerSettings {
  readonly headersTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly keepAliveTimeoutMs: number;
  readonly maxConnections: number;
  /** How long a shutdown waits for in-flight requests before it closes their sockets. */
  readonly shutdownGraceMs: number;
}

export type HttpListenerSettingKey = keyof HttpListenerSettings;

/**
 * `shutdownGraceMs` is 8 s because Docker's and Compose's default stop timeout is 10 s, after which
 * the process is killed: a grace longer than that is a promise the orchestrator does not keep, and
 * the remaining 2 s are the scheduler drains and the pool's own close.
 */
export const DEFAULT_HTTP_LISTENER_SETTINGS: HttpListenerSettings = {
  headersTimeoutMs: 60_000,
  requestTimeoutMs: 300_000,
  keepAliveTimeoutMs: 125_000,
  maxConnections: 4_096,
  shutdownGraceMs: 8_000,
};

interface SettingSpec {
  readonly flag: string;
  readonly min: number;
  readonly max: number;
}

export const HTTP_LISTENER_SETTING_SPECS: { readonly [K in HttpListenerSettingKey]: SettingSpec } = {
  headersTimeoutMs: { flag: "--http-headers-timeout-ms", min: 1_000, max: 600_000 },
  requestTimeoutMs: { flag: "--http-request-timeout-ms", min: 1_000, max: 3_600_000 },
  keepAliveTimeoutMs: { flag: "--http-keep-alive-timeout-ms", min: 1_000, max: 600_000 },
  maxConnections: { flag: "--http-max-connections", min: 1, max: 1_000_000 },
  shutdownGraceMs: { flag: "--shutdown-grace-ms", min: 0, max: 300_000 },
};

export function httpListenerSettingForFlag(flag: string): HttpListenerSettingKey | undefined {
  for (const [key, spec] of Object.entries(HTTP_LISTENER_SETTING_SPECS)) {
    if (spec.flag === flag) return key as HttpListenerSettingKey;
  }
  return undefined;
}

/** Refuses rather than clamps: a bound an operator typed and did not get is a bound they believe. */
export function parseHttpListenerSetting(key: HttpListenerSettingKey, raw: string): number {
  const spec = HTTP_LISTENER_SETTING_SPECS[key];
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${spec.flag} must be a whole number, got "${raw}"`);
  }
  const value = Number(raw);
  if (value < spec.min || value > spec.max) {
    throw new Error(`${spec.flag} must be between ${String(spec.min)} and ${String(spec.max)}, got ${raw}`);
  }
  return value;
}

/**
 * The defaults with the given overrides, refusing the one combination Node accepts silently and
 * that means nothing: a headers timeout longer than the whole-request timeout.
 */
export function resolveHttpListenerSettings(
  overrides: Partial<HttpListenerSettings> = {},
): HttpListenerSettings {
  const settings = { ...DEFAULT_HTTP_LISTENER_SETTINGS, ...overrides };
  if (settings.headersTimeoutMs > settings.requestTimeoutMs) {
    throw new Error(
      `${HTTP_LISTENER_SETTING_SPECS.headersTimeoutMs.flag} (${String(settings.headersTimeoutMs)}) must not exceed ` +
        `${HTTP_LISTENER_SETTING_SPECS.requestTimeoutMs.flag} (${String(settings.requestTimeoutMs)})`,
    );
  }
  return settings;
}

/** The slice of Node's `http.Server` these settings are applied to and a shutdown drives. */
export interface ListenerServerLike {
  headersTimeout: number;
  requestTimeout: number;
  keepAliveTimeout: number;
  maxConnections: number | undefined;
  /**
   * Optional only because `@types/node` does not declare it on `Server`, though Node reads it on
   * `listening` (`lib/_http_server.js`). The live test in `http-listener.test.ts` is what proves the
   * write takes effect: with the assignment removed a stalled header waits out Node's 30 s sweep.
   */
  connectionsCheckingInterval?: number;
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections(): void;
  closeAllConnections(): void;
}

export function applyHttpListenerSettings(server: ListenerServerLike, settings: HttpListenerSettings): void {
  server.headersTimeout = settings.headersTimeoutMs;
  server.requestTimeout = settings.requestTimeoutMs;
  server.keepAliveTimeout = settings.keepAliveTimeoutMs;
  server.maxConnections = settings.maxConnections;
  server.connectionsCheckingInterval = connectionsCheckingIntervalFor(settings);
}

/**
 * How often Node sweeps open connections for an expired `headersTimeout` / `requestTimeout`.
 *
 * Node enforces both timeouts only on that sweep, whose default is 30 s, so a timeout below it is
 * not what it names: measured live, `--http-headers-timeout-ms 2000` answered a slowloris 408 after
 * 26.2 s. Half the shorter timeout bounds the overshoot to that half, floored at 1 s so a short
 * setting does not become a busy timer, and capped at Node's own 30 s so the default is unchanged.
 * Read on `listening`, which is why it is set here with the timeouts and before the server listens.
 */
export function connectionsCheckingIntervalFor(settings: HttpListenerSettings): number {
  const shorter = Math.min(settings.headersTimeoutMs, settings.requestTimeoutMs);
  return Math.min(30_000, Math.max(1_000, Math.floor(shorter / 2)));
}

export function formatHttpListenerSettings(settings: HttpListenerSettings): string {
  return (
    `listener: headers ${String(settings.headersTimeoutMs)} ms, request ${String(settings.requestTimeoutMs)} ms, ` +
    `keep-alive ${String(settings.keepAliveTimeoutMs)} ms, max ${String(settings.maxConnections)} connections, ` +
    `shutdown grace ${String(settings.shutdownGraceMs)} ms`
  );
}

export type ListenerShutdownOutcome = "drained" | "grace_elapsed";

/**
 * Stops accepting, lets the requests already running finish, and closes what is still open when the
 * grace runs out. `server.close()` closes the sockets idle when it is called, and not one that goes
 * idle afterwards — which a proxy then holds for its own keep-alive, minutes — so idle sockets are
 * swept repeatedly and, at the grace, every remaining one is closed with whatever it was doing.
 */
export function closeListener(
  server: ListenerServerLike,
  graceMs: number,
  timers: {
    readonly setTimeout: (fn: () => void, ms: number) => unknown;
    readonly clearTimeout: (handle: unknown) => void;
  } = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): Promise<ListenerShutdownOutcome> {
  return new Promise((resolve) => {
    let outcome: ListenerShutdownOutcome = "drained";
    let done = false;
    const timer = timers.setTimeout(() => {
      outcome = "grace_elapsed";
      server.closeAllConnections();
    }, graceMs);
    // Repeated, not once. A request that finishes after the close leaves its socket idle in
    // keep-alive, and nothing closes it then — measured, a drain whose last request ended after
    // `close()` waited out the whole grace for a socket doing nothing.
    const sweep = (): void => {
      if (done) return;
      server.closeIdleConnections();
      timers.setTimeout(sweep, IDLE_SWEEP_MS);
    };
    server.close(() => {
      done = true;
      timers.clearTimeout(timer);
      resolve(outcome);
    });
    sweep();
  });
}

const IDLE_SWEEP_MS = 50;
