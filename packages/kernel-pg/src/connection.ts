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

/**
 * The shape of a `tenant_id` a scope predicate will bind, and the whole of that check.
 *
 * Loose on purpose — hex digits and dashes, up to 64 — because the value is **bound as a
 * parameter** in every statement that reaches it, so this is not an injection guard but a fail-fast
 * on a caller that passed something that could never be a tenant id. Seven of the eight packages
 * that held a copy of `scopeFilter` spelled exactly this regex and exactly this message, which is
 * why both move here unchanged: every `/invalid tenantId/` assertion in the workspace still matches.
 *
 * `dr-runtime-pg` deliberately keeps a **stricter** local one (a full UUID) and applies it before
 * delegating here. That is a package's own judgement about its callers, not a disagreement about
 * what this function needs, so it stays where it was rather than widening or narrowing this.
 */
const SCOPE_TENANT_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

export function assertScopeTenantId(tenantId: string): void {
  if (!SCOPE_TENANT_ID_RE.test(tenantId)) {
    throw new Error(`invalid tenantId for RLS context: ${JSON.stringify(tenantId)}`);
  }
}

/** A `tenant_id` predicate and the parameters it binds, for one scope. */
export interface ScopeFilter {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * The `tenant_id` predicate a scoped statement carries, **beside** RLS rather than instead of it.
 *
 * RLS alone is not enough, and the reason is ordinary rather than exotic: **a table's owner bypasses
 * its policies**, and a deployment that connects as the owner is a normal deployment. ADR-0331 and
 * ADR-0333 swept fourteen store classes across seven packages for want of this predicate, and the
 * damage was never a visibly long result set — it was a *wrong scalar*. `latestForFramework(
 * "soc2_type2")` returned a tenant's failing SOC 2 report as the platform's and answered "are we
 * certifiable" with `false`; `countBreachesSince` answered 3 where the scope's own count is 1, a 3×
 * burn-rate input on the path that pages; `loadForIncident` *threw* on healthy data.
 *
 * **It lives here because `kernel-pg` is the only dependency every scope-carrying package shares.**
 * Eight packages held a verbatim copy, each with a comment naming this module as the destination;
 * no other home avoids a backwards dependency.
 *
 * ## Which spelling, and the one rule that decides
 *
 * **The predicate reproduces what a non-owner would have been shown, no wider and no narrower.**
 *
 * - `scopeFilter` — strict. Right where a scope's rows are a **closed set**: a hash chain, a
 *   certification report, a DR drill. A platform failover drill is not evidence about a tenant's
 *   disaster recovery, so mixing them is the defect rather than the behaviour.
 * - `scopeFilterWithPlatform` — inclusive. Right where a platform row is **meant** to serve a
 *   tenant: a feature flag, a public key, a platform-wide workflow definition. That is the `SELECT`-
 *   scoped platform read arm, which grants without a grant, and it is how Postgres combines two
 *   permissive policies. Strict everywhere would have made these stores owner-independent by
 *   **destroying** documented behaviour rather than by reproducing it.
 *
 * The catalog says which is which: `idx_workflow_definitions_platform_key_version … WHERE tenant_id
 * IS NULL` is the platform read arm written down.
 *
 * **A write takes the strict form, always** — see `assertScopedWriteLanded`. The inclusive arm on a
 * write is not a wider read, it is a route from one scope into another's row: a tenant-scoped
 * `UPDATE` matching `tenant_id IS NULL` would let a tenant flip `gateway.strict_jwt_aud`.
 *
 * ## Why it branches
 *
 * Both functions **branch** rather than using `tenant_id IS NOT DISTINCT FROM $1`, the one operator
 * matching NULL to NULL and therefore the tempting single code path. Measured, twice, on 45k rows:
 * with a **literal** NULL it *is* index-scanned, because Postgres constant-folds it — but with a
 * **bound parameter**, which is how a store issues it, it is a sequential scan. 10.67 ms against
 * 0.73 ms, and 24.7 ms against 1.7 ms. **The penalty is invisible in a psql session and real in
 * production.** The inclusive arm keeps its index too: Postgres plans the disjunction as a
 * **BitmapOr** over the same index, because each arm is an indexable operator on its own. That is
 * precisely the property the single-operator form lacks.
 *
 * `IS NOT DISTINCT FROM` is still right in one position, and `assertScopedWriteLanded`'s callers use
 * it there: inside an `ON CONFLICT … DO UPDATE WHERE`, where both operands come from one already-
 * located row and no index is consulted at all.
 *
 * `firstParam` is the 1-based position the predicate's own parameter takes, so a caller that already
 * binds values can place this anywhere in its list.
 */
export function scopeFilter(tenantId: string | null, firstParam = 1): ScopeFilter {
  // `tenant_id = NULL` is never true, so the platform scope cannot ride along as a bound parameter
  // and has to be asked for as `IS NULL`.
  if (tenantId === null) return { sql: "tenant_id IS NULL", params: [] };
  assertScopeTenantId(tenantId);
  return { sql: `tenant_id = $${String(firstParam)}`, params: [tenantId] };
}

/**
 * `scopeFilter` with the platform's rows kept in a tenant's answer — see the rule above for when
 * that is the right predicate and when it is the defect.
 *
 * For the platform scope the two functions agree on `tenant_id IS NULL`, and that is the arm the
 * defect was always in: the platform read is the one that was answering with a tenant's row.
 */
export function scopeFilterWithPlatform(
  tenantId: string | null,
  firstParam = 1,
): ScopeFilter {
  if (tenantId === null) return scopeFilter(null, firstParam);
  assertScopeTenantId(tenantId);
  return {
    sql: `(tenant_id = $${String(firstParam)} OR tenant_id IS NULL)`,
    params: [tenantId],
  };
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
