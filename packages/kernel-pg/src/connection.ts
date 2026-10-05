export interface PgQueryResult<T = Record<string, unknown>> {
  readonly rows: readonly T[];
  readonly rowCount: number;
}

export interface PgConnection {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult<T>>;
  transaction<T>(fn: (tx: PgConnection) => Promise<T>): Promise<T>;
  withAdvisoryLock<T>(lockKey: bigint, fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PgConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly ssl: "disable" | "require" | "prefer" | "allow" | "verify-ca" | "verify-full";
  readonly applicationName: string;
}

const DEFAULT_PORT = 5432;
const DEFAULT_APPLICATION_NAME = "crossengin-pg";
const VALID_SSL_MODES = new Set([
  "disable",
  "require",
  "prefer",
  "allow",
  "verify-ca",
  "verify-full",
]);

export function parsePgEnvConfig(env: NodeJS.ProcessEnv = process.env): PgConfig {
  const host = env["PGHOST"];
  if (host === undefined || host.length === 0) {
    throw new Error("PGHOST is not set");
  }
  const user = env["PGUSER"];
  if (user === undefined || user.length === 0) {
    throw new Error("PGUSER is not set");
  }
  const database = env["PGDATABASE"];
  if (database === undefined || database.length === 0) {
    throw new Error("PGDATABASE is not set");
  }
  const portRaw = env["PGPORT"];
  let port = DEFAULT_PORT;
  if (portRaw !== undefined && portRaw.length > 0) {
    const parsed = Number.parseInt(portRaw, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`PGPORT is not a valid TCP port: ${portRaw}`);
    }
    port = parsed;
  }
  const sslModeRaw = env["PGSSLMODE"] ?? "prefer";
  if (!VALID_SSL_MODES.has(sslModeRaw)) {
    throw new Error(`PGSSLMODE is not recognized: ${sslModeRaw}`);
  }
  return {
    host,
    port,
    user,
    password: env["PGPASSWORD"] ?? "",
    database,
    ssl: sslModeRaw as PgConfig["ssl"],
    applicationName: env["PGAPPNAME"] ?? DEFAULT_APPLICATION_NAME,
  };
}

export function looksLikeProductionDatabase(database: string): boolean {
  const lower = database.toLowerCase();
  return (
    lower.includes("prod") ||
    lower.includes("production") ||
    lower.endsWith("_live") ||
    lower === "live"
  );
}

export type ConnectionFactory = (config: PgConfig) => PgConnection;

/**
 * A value a `PgConnection` handed back, as the ISO 8601 text every contract in this workspace
 * declares a timestamp to be.
 *
 * It lives beside `PgQueryResult` because it is a fact about that interface's rows, and because it
 * is wanted in four packages — every one of which already depends on this one. Measured against
 * Postgres 16 through node-postgres: `TIMESTAMPTZ`, `TIMESTAMP` **and** `DATE` all arrive as a JS
 * `Date`, never as text. So a stored-row interface that types one `string` makes the compiler vouch
 * for something false, and the `!==` a drift comparison is written with then answers "different"
 * for every row that has one set — which is what ADR-0330 found live in one replayer. The offline
 * fakes hand back strings, which is exactly why no test caught it.
 *
 * `String(date)` is not a repair. It yields `Mon Oct 05 2026 03:38:51 GMT+0000 (Coordinated
 * Universal Time)`: the milliseconds are gone, and Postgres **refuses** to parse it back
 * (`invalid input syntax for type timestamp with time zone`), so a keyset cursor built that way
 * raises on the very next page. Both measured.
 *
 * An unparseable string comes back **as it stands** rather than as `null`, because `null` means
 * "no timestamp" and a garbage column must not compare equal to an absent one.
 */
export function isoInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : new Date(ms).toISOString();
  }
  return String(value);
}

/**
 * `isoInstant` for a `NOT NULL` column, where an absent value means the row cannot be read at all.
 *
 * Throwing rather than substituting is ADR-0289's rule: a row that no longer satisfies the shape
 * its table guarantees is a finding, and a reader handed a fabricated timestamp has no way to
 * notice.
 */
export function requireIsoInstant(value: unknown, field: string): string {
  const iso = isoInstant(value);
  if (iso === null) throw new Error(`row is missing required timestamp: ${field}`);
  return iso;
}

/**
 * A `DATE` column as the `YYYY-MM-DD` text it was written as.
 *
 * Separate from `isoInstant` for a measured reason: node-postgres parses a `DATE` into **local**
 * midnight, not UTC midnight. Against the same `'2026-10-05'::date`, `toISOString()` answers
 * `2026-10-05T00:00:00.000Z` under `TZ=UTC`, `2026-10-05T04:00:00.000Z` under
 * `TZ=America/New_York` and `2026-10-04T15:00:00.000Z` under `TZ=Asia/Tokyo` — so slicing the ISO
 * text gives the **previous day** anywhere east of UTC. The local calendar parts are right in all
 * three, so those are what this reads.
 */
export function isoCalendarDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "Invalid Date";
    const y = value.getFullYear().toString().padStart(4, "0");
    const m = (value.getMonth() + 1).toString().padStart(2, "0");
    const d = value.getDate().toString().padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return typeof value === "string" ? value : String(value);
}
