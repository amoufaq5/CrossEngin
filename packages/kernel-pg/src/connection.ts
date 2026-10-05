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

/**
 * The GUCs a **platform-scope** write is elevated by, and the whole of that vocabulary.
 *
 * Every tenant-scoped meta table whose `tenant_id` is nullable carries, since ADR-0313, three or
 * four RLS policies rather than one: tenant isolation (`ALL`), a `SELECT`-only platform read, and an
 * `INSERT`-scoped platform write — plus an `UPDATE`-scoped one where the row is changed in place.
 * The write policies check one of these settings, so the setting *is* the privilege, and this is the
 * only place its name is spelled for a writer. (`canonical.test.ts` pins these four against the
 * policies the real catalog declares, so a name drifting on one side fails there rather than in
 * production, where the symptom is a write that silently matches no policy.)
 *
 * They live beside `PgConnection` for the reason the row normalisers below live beside
 * `PgQueryResult`: a transaction-local `set_config` is a fact about the *session* this interface
 * describes, and it is wanted in eight packages, every one of which already depends on this one.
 *
 * **Four rather than one, and four rather than twenty-nine.** One grant for everything would be a
 * single privilege spanning the deployment's tamper-evident trail, its telemetry, its configuration
 * and its key registry; one per table would be twenty-nine settings nobody configures correctly. The
 * boundary is drawn where there is a population that should hold one side and not the other:
 *
 * - `audit` — *may this session enter a fact into the tamper-evident record?* (`meta.audit_log` and
 *   the two forensic-chain tables; ADR-0331 established it and nothing is added to it here.)
 * - `record` — *may this session record what the deployment's own machinery observed or did?* SLO
 *   evaluations, DR drills, rate-limit decisions, the lineage graph, `meta.crypto_audit`.
 * - `config` — *may this session change what the deployment does?* Feature flags, kill switches,
 *   workflow definitions, rate-limit policies, quota definitions, SSO providers.
 * - `key` — *may this session introduce a key the deployment's signatures will be verified against?*
 *   `meta.crypto_keys` alone.
 *
 * The sharpest of those boundaries is `audit` against `key`: a session that may write the trail must
 * not be able to register the public key its own entries' signatures resolve against, or it could
 * re-sign a rewritten chain. That is ADR-0313's rule — a grant over the record must not reach the
 * thing that validates the record — and it is why `meta.crypto_audit` is `record` and not `key`: the
 * population that may register a platform key is precisely the population whose conduct those rows
 * record. `config` against `record` is the one that would bite soonest in practice: a DR drill
 * scheduler that could also flip `gateway.strict_jwt_aud` is an authentication bypass.
 *
 * None of the four is ever a `USING` on a `SELECT` policy. A read grant that also authorised a write
 * is the hole ADR-0313 split one policy into two to close, and it must not be reintroduced from the
 * other direction.
 */
export const PLATFORM_WRITE_GRANTS = Object.freeze({
  audit: "app.platform_audit_write",
  record: "app.platform_record_write",
  config: "app.platform_config_write",
  key: "app.platform_key_write",
} as const);

export type PlatformWriteGrant = keyof typeof PLATFORM_WRITE_GRANTS;

/**
 * The statement a writer runs to claim one of those grants, for the length of its transaction.
 *
 * `set_config(…, true)` — the third argument is `is_local` — so the setting is reverted when the
 * transaction ends and a pooled connection cannot carry the elevation into the next caller's work.
 * A session-wide `SET` would turn one platform write into a standing privilege on that connection.
 */
export function setPlatformWriteSql(grant: PlatformWriteGrant): string {
  return `SELECT set_config('${PLATFORM_WRITE_GRANTS[grant]}', 'on', true)`;
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
