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

/**
 * The modes `PGSSLMODE` is written with, in **ascending order of what they promise** — which is
 * libpq's own order and is the only reason not to alphabetise this.
 *
 * All six of libpq's names are listed and one of them, `verify-ca`, is **refused at parse**. It
 * stays in the union deliberately: the maps below have to answer for it, because *this binding
 * cannot honour it* is a fact about the mode and not an absence of one, and deleting the name would
 * leave the refusal with nothing to name.
 */
export const PG_SSL_MODES = [
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
] as const;

export type PgSslMode = (typeof PG_SSL_MODES)[number];

const PG_SSL_MODE_NAMES: ReadonlySet<string> = new Set(PG_SSL_MODES);

/**
 * Whether a string is one of the six, compared **case-sensitively** as libpq compares it — so
 * `Require` is unrecognised rather than quietly accepted as something it is not spelled as.
 */
export function isPgSslMode(value: string): value is PgSslMode {
  return PG_SSL_MODE_NAMES.has(value);
}

/**
 * What a mode actually buys on the wire, as three facts rather than a boolean.
 *
 * This matters more here than it would for most connections: **this channel carries
 * `app.current_tenant_id`**, which is the whole tenant-isolation boundary, and on the column store
 * it carries `app.column_encryption_key` as a bound parameter — so under `--store pg-columns` the
 * at-rest PHI key crosses this wire on every write. The repo's own managed-cloud guide prescribes
 * `require` for an internet hop to Supabase, which is the middle fact and not the last one.
 *
 * - `plaintext_possible` — the connection may proceed with no TLS at all. `disable` never offers
 *   it, `allow` and `prefer` let the **server** decide, and all three share one answer because the
 *   fact a boot line needs is *can this channel carry the tenant id and the column key in the
 *   clear*, which is true of every one of them; they differ only in who declines.
 * - `encrypted_unauthenticated` — encrypted against a passive observer, and nothing against an
 *   active one: the peer is whoever answered, and a man in the middle offering any certificate is
 *   accepted.
 * - `authenticated` — the server's certificate chain is validated.
 *
 * Three rather than a boolean because "not validated" collapses two different **remedies**: a
 * `prefer` deployment has to arrange TLS, while a `require` deployment already has it and needs the
 * trust decision. Reporting both as unvalidated sends the first operator to the trust store and the
 * second to the port.
 */
export const PG_CHANNEL_ASSURANCES = [
  "plaintext_possible",
  "encrypted_unauthenticated",
  "authenticated",
] as const;

export type PgChannelAssurance = (typeof PG_CHANNEL_ASSURANCES)[number];

/**
 * A **total map**, so a seventh mode is a compile error here rather than a member inheriting
 * whichever answer an `if`-chain ended on — and the answer it would inherit from the chain
 * `node-pg.ts` writes is the one that overstates the channel.
 *
 * `verify-ca` is the member that proves the point, and its value is **measured rather than
 * principled**: `createNodePgConnection` builds `{ rejectUnauthorized: config.ssl ===
 * "verify-full" }`, so under `verify-ca` node accepts any certificate the server offers. A mode
 * whose entire purpose is to validate the CA validates nothing, which is why this says
 * `encrypted_unauthenticated` — the honest description of what that code does — while
 * `parsePgEnvConfig` refuses the mode outright.
 */
const SSL_MODE_CHANNEL_ASSURANCE: Readonly<Record<PgSslMode, PgChannelAssurance>> = {
  disable: "plaintext_possible",
  allow: "plaintext_possible",
  prefer: "plaintext_possible",
  require: "encrypted_unauthenticated",
  "verify-ca": "encrypted_unauthenticated",
  "verify-full": "authenticated",
};

export function pgChannelAssurance(mode: PgSslMode): PgChannelAssurance {
  return SSL_MODE_CHANNEL_ASSURANCE[mode];
}

/**
 * The sentence a boot line or a survey prints, keyed per **assurance** and not per mode — three
 * strings rather than six, because the mode's name carries nothing the assurance does not and two
 * modes with one assurance have one thing to say.
 */
export const PG_CHANNEL_ASSURANCE_DESCRIPTIONS: Readonly<Record<PgChannelAssurance, string>> = {
  plaintext_possible:
    "the server may decline TLS and the connection proceeds in the clear, carrying the tenant " +
    "context and any column encryption key with it",
  encrypted_unauthenticated:
    "encrypted against a passive observer, but the server's identity is unverified, so an active " +
    "man in the middle offering any certificate is accepted",
  authenticated:
    "encrypted, and the server's certificate chain is validated against node's own trust store — " +
    "this binding accepts no CA material (there is no `ca` field and PGSSLROOTCERT is never read), " +
    "so a server presenting a privately-signed certificate is refused rather than trusted",
};

const ASSURANCE_VALIDATES_CERTIFICATE: Readonly<Record<PgChannelAssurance, boolean>> = {
  plaintext_possible: false,
  encrypted_unauthenticated: false,
  authenticated: true,
};

/**
 * Whether this mode validates the server's certificate — `verify-full` and nothing else.
 *
 * **Derived through the assurance rather than written as a second per-mode map**, because two maps
 * carrying one judgement can disagree about one mode and the disagreement would be invisible: this
 * predicate gates a refusal and `pgChannelAssurance` gates what an operator is told, so a mode
 * reported `authenticated` while this answered `false` would refuse a working deployment with a
 * message contradicting its own boot line. Composing two total maps writes the judgement once and
 * still makes a seventh mode — or a fourth assurance — a compile error.
 */
export function sslModeValidatesCertificate(mode: PgSslMode): boolean {
  return ASSURANCE_VALIDATES_CERTIFICATE[SSL_MODE_CHANNEL_ASSURANCE[mode]];
}

/**
 * Whether this mode makes TLS **mandatory** — `require`, `verify-ca` and `verify-full`.
 *
 * A second question about the same six modes, and a different one from
 * {@link sslModeValidatesCertificate}: *must there be TLS at all* versus *is the peer checked*.
 * `require` answers yes and no.
 *
 * Derived through the assurance for its sibling's reason, and it is exactly the complement of
 * `plaintext_possible` — so `node-pg.ts` can stop listing the three mode names, which was a second
 * spelling of this set. The one name comparison that survives there is `disable`, which this
 * predicate deliberately cannot answer: `disable`, `allow` and `prefer` share one assurance and
 * differ only in *who declines*, so `disable` must pass `ssl: false` where the other two pass
 * nothing and let the server decide.
 */
export function sslModeRequiresTls(mode: PgSslMode): boolean {
  return SSL_MODE_CHANNEL_ASSURANCE[mode] !== "plaintext_possible";
}

export interface PgConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly ssl: PgSslMode;
  readonly applicationName: string;
}

const DEFAULT_PORT = 5432;
const DEFAULT_APPLICATION_NAME = "crossengin-pg";

/**
 * Why a recognised mode is refused, and why a refusal rather than a warning.
 *
 * **A mode that claims to verify and does not is worse than one that makes no claim**: an operator
 * who sets `verify-ca` has made the trust decision and believes it took effect, so a warning they
 * scroll past leaves them with `require`'s guarantees under `verify-full`'s name. Nothing can repair
 * it by configuration either — `PgConfig` has no `ca` field, nothing anywhere reads `PGSSLROOTCERT`,
 * and the one mode that sets `rejectUnauthorized` is `verify-full` — so the only honest outcomes are
 * to implement it or to decline it, and this declines it.
 */
const VERIFY_CA_REFUSAL =
  "PGSSLMODE=verify-ca is refused: certificate verification is not implemented for it. No CA " +
  "material is accepted anywhere in this binding — PgConfig carries no `ca` field and " +
  "PGSSLROOTCERT is never read — so the connection would validate nothing while naming the mode " +
  "whose purpose is to validate. Use PGSSLMODE=verify-full, the one mode that validates the " +
  "server's certificate, or PGSSLMODE=require to state plainly that the channel is encrypted and " +
  "unauthenticated.";

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
  // The default is `prefer`, which is `plaintext_possible`: an absent PGSSLMODE is not a statement
  // about the channel, and nothing here upgrades it to one.
  const sslModeRaw = env["PGSSLMODE"] ?? "prefer";
  // Recognised first, then refused, and the two messages stay distinguishable: an unrecognised
  // value is a typo and a recognised one this binding will not serve is a decision, so they send an
  // operator to different places.
  if (!isPgSslMode(sslModeRaw)) {
    throw new Error(`PGSSLMODE is not recognized: ${sslModeRaw}`);
  }
  if (sslModeRaw === "verify-ca") {
    throw new Error(VERIFY_CA_REFUSAL);
  }
  return {
    host,
    port,
    user,
    password: env["PGPASSWORD"] ?? "",
    database,
    ssl: sslModeRaw,
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
