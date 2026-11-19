import { readFileSync } from "node:fs";

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
 * What a mode actually buys on the wire, as four facts rather than a boolean.
 *
 * This matters more here than it would for most connections: **this channel carries
 * `app.current_tenant_id`**, which is the whole tenant-isolation boundary, and on the column store
 * it carries `app.column_encryption_key` as a bound parameter.
 *
 * - `plaintext_possible` — the connection may proceed with no TLS at all: `disable` never offers
 *   it, and `allow` and `prefer` negotiate it (see `pgTlsPlan` in `node-pg.ts`) and fall back.
 * - `encrypted_unauthenticated` — encrypted against a passive observer, and nothing against an
 *   active one: a man in the middle offering any certificate is accepted.
 * - `chain_validated` — the certificate chain is validated against `PGSSLROOTCERT` and the
 *   hostname is not checked (`verify-ca`): any server holding a certificate that root signed is
 *   accepted, whatever name it answers to.
 * - `authenticated` — the chain is validated and the certificate names the host connected to.
 *
 * Four rather than a boolean because each step has a different **remedy**: arrange TLS, make the
 * trust decision, or name the host.
 */
export const PG_CHANNEL_ASSURANCES = [
  "plaintext_possible",
  "encrypted_unauthenticated",
  "chain_validated",
  "authenticated",
] as const;

export type PgChannelAssurance = (typeof PG_CHANNEL_ASSURANCES)[number];

/** A total map, so a seventh mode is a compile error rather than an inherited answer. */
const SSL_MODE_CHANNEL_ASSURANCE: Readonly<Record<PgSslMode, PgChannelAssurance>> = {
  disable: "plaintext_possible",
  allow: "plaintext_possible",
  prefer: "plaintext_possible",
  require: "encrypted_unauthenticated",
  "verify-ca": "chain_validated",
  "verify-full": "authenticated",
};

export function pgChannelAssurance(mode: PgSslMode): PgChannelAssurance {
  return SSL_MODE_CHANNEL_ASSURANCE[mode];
}

/**
 * The sentence a boot line prints, keyed per **assurance** and not per mode. Where the trust
 * anchors come from is said beside it by `describePgChannel`, because that is a fact about the
 * configuration rather than about the mode.
 */
export const PG_CHANNEL_ASSURANCE_DESCRIPTIONS: Readonly<Record<PgChannelAssurance, string>> = {
  plaintext_possible:
    "TLS is not mandatory: disable never offers it, and allow/prefer negotiate it once per pool " +
    "and fall back to the clear — carrying the tenant context and any column encryption key with " +
    "it — and when they do encrypt, the server's identity is unverified",
  encrypted_unauthenticated:
    "encrypted against a passive observer, but the server's identity is unverified, so an active " +
    "man in the middle offering any certificate is accepted",
  chain_validated:
    "encrypted, and the server's certificate chain is validated against PGSSLROOTCERT, but the " +
    "hostname is not checked, so any server holding a certificate that root signed is accepted",
  authenticated:
    "encrypted, the server's certificate chain is validated and the certificate must name the " +
    "host this binding connects to",
};

const ASSURANCE_VALIDATES_CHAIN: Readonly<Record<PgChannelAssurance, boolean>> = {
  plaintext_possible: false,
  encrypted_unauthenticated: false,
  chain_validated: true,
  authenticated: true,
};

const ASSURANCE_CHECKS_HOSTNAME: Readonly<Record<PgChannelAssurance, boolean>> = {
  plaintext_possible: false,
  encrypted_unauthenticated: false,
  chain_validated: false,
  authenticated: true,
};

/**
 * Whether this mode validates the server's certificate chain — `verify-ca` and `verify-full`.
 *
 * Derived through the assurance rather than written as a second per-mode map: this predicate
 * decides what node's TLS stack is asked to reject and the assurance decides what an operator is
 * told, so two maps could disagree about one mode invisibly.
 */
export function sslModeValidatesCertificate(mode: PgSslMode): boolean {
  return ASSURANCE_VALIDATES_CHAIN[SSL_MODE_CHANNEL_ASSURANCE[mode]];
}

/** Whether this mode also requires the certificate to name the host — `verify-full` alone. */
export function sslModeChecksHostname(mode: PgSslMode): boolean {
  return ASSURANCE_CHECKS_HOSTNAME[SSL_MODE_CHANNEL_ASSURANCE[mode]];
}

/**
 * Whether this mode makes TLS **mandatory** — `require`, `verify-ca` and `verify-full`, exactly
 * the complement of `plaintext_possible`. `require` is what separates it from
 * {@link sslModeValidatesCertificate}: TLS is mandatory and the peer unchecked.
 */
export function sslModeRequiresTls(mode: PgSslMode): boolean {
  return SSL_MODE_CHANNEL_ASSURANCE[mode] !== "plaintext_possible";
}

/**
 * Where a validating mode's trust anchors come from — libpq's `PGSSLROOTCERT`.
 *
 * `system` is libpq's spelling for the platform store; here that is node's bundled CA store, which
 * is also what a validating mode uses when `PGSSLROOTCERT` is unset. A `file` carries the PEM text,
 * read once at parse so an unreadable or empty file is a boot refusal naming the path rather than a
 * TLS failure on the first query. Given a file, node trusts **only** the roots in it.
 */
export type PgSslRootCert =
  | { readonly kind: "system" }
  | { readonly kind: "file"; readonly path: string; readonly pem: string };

export interface PgConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly ssl: PgSslMode;
  /** `null` when `PGSSLROOTCERT` is unset. */
  readonly sslRootCert: PgSslRootCert | null;
  readonly applicationName: string;
}

const DEFAULT_PORT = 5432;
const DEFAULT_APPLICATION_NAME = "crossengin-pg";
const PEM_CERTIFICATE = "-----BEGIN CERTIFICATE-----";

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * `PGSSLROOTCERT`, read and checked. Refusals mirror libpq's: `verify-ca` with no root is refused,
 * because node's bundled store would then admit a certificate any public CA issued to anyone with
 * the hostname unchecked; and `system` is refused below `verify-full`, which libpq 16 refuses too.
 */
function parseSslRootCert(
  mode: PgSslMode,
  raw: string | undefined,
  readFile: (path: string) => string,
): PgSslRootCert | null {
  if (raw === undefined || raw.length === 0) {
    if (mode === "verify-ca") {
      throw new Error(
        "PGSSLMODE=verify-ca needs PGSSLROOTCERT: it validates the chain and not the hostname, so " +
          "with no root of its own it would accept a certificate any public CA issued to anyone. " +
          "Set PGSSLROOTCERT to the server's root certificate file, or use PGSSLMODE=verify-full.",
      );
    }
    return null;
  }
  if (raw === "system") {
    if (mode !== "verify-full") {
      throw new Error(
        `PGSSLROOTCERT=system is refused with PGSSLMODE=${mode}: the system store is only safe ` +
          "with hostname verification (libpq refuses the same pair). Use PGSSLMODE=verify-full.",
      );
    }
    return { kind: "system" };
  }
  let pem: string;
  try {
    pem = readFile(raw);
  } catch (err) {
    throw new Error(
      `PGSSLROOTCERT ${raw} cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!pem.includes(PEM_CERTIFICATE)) {
    throw new Error(`PGSSLROOTCERT ${raw} holds no PEM certificate (no "${PEM_CERTIFICATE}" line)`);
  }
  return { kind: "file", path: raw, pem };
}

/**
 * Reads the libpq environment. `readFile` is injectable so a test need not touch the disk; it is
 * called only when `PGSSLROOTCERT` names a file.
 */
export function parsePgEnvConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = defaultReadFile,
): PgConfig {
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
  // libpq's default. With this binding it now means what libpq means — TLS is offered first and the
  // connection falls back to the clear only when it is declined — rather than "never offered".
  const sslModeRaw = env["PGSSLMODE"] ?? "prefer";
  if (!isPgSslMode(sslModeRaw)) {
    throw new Error(`PGSSLMODE is not recognized: ${sslModeRaw}`);
  }
  return {
    host,
    port,
    user,
    password: env["PGPASSWORD"] ?? "",
    database,
    ssl: sslModeRaw,
    sslRootCert: parseSslRootCert(sslModeRaw, env["PGSSLROOTCERT"], readFile),
    applicationName: env["PGAPPNAME"] ?? DEFAULT_APPLICATION_NAME,
  };
}

/** What the database channel promises, as the one line a boot log prints, with its level. */
export interface PgChannelDescription {
  readonly level: "info" | "warn";
  readonly line: string;
}

/**
 * The boot line for a configuration: the assurance, where a validating mode's trust anchors come
 * from, and — for a mode that validates nothing — that a `PGSSLROOTCERT` the operator set is
 * unused, because libpq would have used it under `require` and this binding does not.
 */
export function describePgChannel(
  config: Pick<PgConfig, "ssl" | "sslRootCert">,
): PgChannelDescription {
  const assurance = pgChannelAssurance(config.ssl);
  const parts = [`database channel: PGSSLMODE=${config.ssl} — ${PG_CHANNEL_ASSURANCE_DESCRIPTIONS[assurance]}`];
  const root = config.sslRootCert;
  if (sslModeValidatesCertificate(config.ssl)) {
    parts.push(
      root?.kind === "file"
        ? `trust anchors: PGSSLROOTCERT ${root.path} only`
        : `trust anchors: node's bundled CA store (PGSSLROOTCERT ${root === null ? "unset" : "system"})`,
    );
  } else if (root !== null) {
    parts.push(
      `PGSSLROOTCERT ${root.kind === "file" ? root.path : "system"} is set and unused under ` +
        `${config.ssl} (libpq would verify the chain under require; this binding verifies only ` +
        "under verify-ca or verify-full)",
    );
  }
  if (sslModeChecksHostname(config.ssl)) return { level: "info", line: parts.join("; ") };
  parts.push(
    sslModeValidatesCertificate(config.ssl)
      ? "PGSSLMODE=verify-full also checks the hostname"
      : "PGSSLMODE=verify-full validates it",
  );
  return { level: "warn", line: parts.join("; ") };
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
 * How many connections a pool holds, how long it waits for one, and the three per-session limits
 * that bound what one statement, one lock wait and one abandoned transaction can cost.
 *
 * `0` on a session limit means **not set**: the server's (or the role's) own default applies, which
 * for a stock Postgres is no limit. It is deliberately not "set it to 0", so a DBA's
 * `ALTER ROLE … SET statement_timeout` survives a binary that was told nothing. `0` on
 * `connectTimeoutMs` is node-postgres's own meaning, wait for ever, and `0` on `idleTimeoutMs`
 * keeps idle connections open indefinitely.
 */
export interface PgPoolSettings {
  readonly maxConnections: number;
  readonly connectTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
}

export type PgPoolSettingKey = keyof PgPoolSettings;

/**
 * What a pool is when nobody chose: node-postgres's own pool defaults made explicit, and **no**
 * session limit. This is what `crossengin apply`, `crossengin-pg` and the operator subcommands run
 * with, on purpose: a migration, a rekey and a by-hand chain verification are each one long
 * operation an operator started and is watching, and a timeout chosen for request traffic would
 * cancel them partway — a rekey or an `encrypt --apply` halted mid-transaction is exactly the
 * outcome those commands are written to avoid.
 */
export const UNBOUNDED_POOL_SETTINGS: PgPoolSettings = Object.freeze({
  maxConnections: 10,
  connectTimeoutMs: 0,
  idleTimeoutMs: 10_000,
  statementTimeoutMs: 0,
  lockTimeoutMs: 0,
  idleInTransactionTimeoutMs: 0,
});

/**
 * The serving process's defaults, each chosen against a measurement rather than a habit.
 *
 * - `connectTimeoutMs` 30s: node-postgres applies it both to opening a connection **and** to
 *   waiting for a free slot in a full pool, so today an unreachable database or an exhausted pool
 *   holds a request for ever. A request that waited 30s for a connection is already lost.
 * - `statementTimeoutMs` 5 min: the longest statement the server issues on its own is the integrity
 *   proof's whole-chain read, measured on PG 16 at **~6 s per million entries** end to end (0.72 s
 *   server-side, the rest node-postgres pacing the socket) — so 5 minutes is ~50M entries, and the
 *   same read holds **~870 MB of heap per million**, so memory gives out an order of magnitude
 *   before this does. A fresh catalog bootstrap is 2.5 s. What it can cancel is a single DELETE in
 *   an Article 17 erasure over a very large tenant table, and the `--pg-statement-timeout-ms` hatch
 *   (0 = unset) exists for exactly that.
 * - `lockTimeoutMs` 60s: every advisory and row lock this binary takes is held for one short
 *   operation (a transaction, or the incident store's session lock around one allocation); the
 *   longest is a per-tenant schema application. A lock wait past a minute is a
 *   wedged holder, and an `ALTER TABLE` queued behind one blocks every later reader of the table.
 * - `idleInTransactionTimeoutMs` 60s: the longest gap between two statements inside one
 *   transaction is the chain read parsing its rows before the transaction ends, measured at **~6 s
 *   per million entries** — so 60 s is ~10M entries, past where the heap runs out.
 */
export const SERVING_POOL_SETTINGS: PgPoolSettings = Object.freeze({
  maxConnections: 10,
  connectTimeoutMs: 30_000,
  idleTimeoutMs: 10_000,
  statementTimeoutMs: 300_000,
  lockTimeoutMs: 60_000,
  idleInTransactionTimeoutMs: 60_000,
});

/**
 * Each setting's flag and bounds, as one total map so a seventh setting is a compile error here
 * rather than a key with no flag and no validation.
 *
 * `zeroAllowed` is separate from `min` because zero is a *meaning* (unset / wait for ever) rather
 * than a small value: a 5 ms statement timeout is not a timeout anybody wants, and a 0 is.
 */
export const PG_POOL_SETTING_SPECS: Readonly<
  Record<
    PgPoolSettingKey,
    { readonly flag: string; readonly min: number; readonly max: number; readonly zeroAllowed: boolean }
  >
> = {
  maxConnections: { flag: "--pg-pool-max", min: 1, max: 1000, zeroAllowed: false },
  connectTimeoutMs: { flag: "--pg-connect-timeout-ms", min: 1000, max: 600_000, zeroAllowed: true },
  idleTimeoutMs: { flag: "--pg-idle-timeout-ms", min: 1000, max: 3_600_000, zeroAllowed: true },
  statementTimeoutMs: {
    flag: "--pg-statement-timeout-ms",
    min: 1000,
    max: 86_400_000,
    zeroAllowed: true,
  },
  lockTimeoutMs: { flag: "--pg-lock-timeout-ms", min: 100, max: 86_400_000, zeroAllowed: true },
  idleInTransactionTimeoutMs: {
    flag: "--pg-idle-in-transaction-timeout-ms",
    min: 1000,
    max: 86_400_000,
    zeroAllowed: true,
  },
};

export const PG_POOL_SETTING_KEYS = Object.keys(PG_POOL_SETTING_SPECS) as readonly PgPoolSettingKey[];

/** The setting a flag names, or `undefined` when the flag is not one of these. */
export function pgPoolSettingForFlag(flag: string): PgPoolSettingKey | undefined {
  return PG_POOL_SETTING_KEYS.find((key) => PG_POOL_SETTING_SPECS[key].flag === flag);
}

/** Parse one setting's value, throwing a message that names the flag and its bounds. */
export function parsePgPoolSetting(key: PgPoolSettingKey, raw: string): number {
  const spec = PG_POOL_SETTING_SPECS[key];
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  const ok =
    Number.isSafeInteger(n) && ((n === 0 && spec.zeroAllowed) || (n >= spec.min && n <= spec.max));
  if (!ok) {
    const range = `${String(spec.min)}..${String(spec.max)}${spec.zeroAllowed ? ", or 0" : ""}`;
    throw new Error(`invalid ${spec.flag}: ${raw} (${range})`);
  }
  return n;
}

/** The PG session parameters a pool sets on each new connection, omitting the unset ones. */
export function pgSessionParameters(
  settings: PgPoolSettings,
): readonly { readonly name: string; readonly valueMs: number }[] {
  const all = [
    { name: "statement_timeout", valueMs: settings.statementTimeoutMs },
    { name: "lock_timeout", valueMs: settings.lockTimeoutMs },
    { name: "idle_in_transaction_session_timeout", valueMs: settings.idleInTransactionTimeoutMs },
  ];
  return all.filter((p) => p.valueMs > 0);
}

/** One line a boot log prints, saying every setting including the ones left unset. */
export function formatPgPoolSettings(settings: PgPoolSettings): string {
  const ms = (n: number, zero: string): string => (n === 0 ? zero : `${String(n)}ms`);
  return (
    `pool max ${String(settings.maxConnections)}, ` +
    `connect timeout ${ms(settings.connectTimeoutMs, "none (waits for ever)")}, ` +
    `idle close ${ms(settings.idleTimeoutMs, "never")}; ` +
    `session statement_timeout ${ms(settings.statementTimeoutMs, "server default")}, ` +
    `lock_timeout ${ms(settings.lockTimeoutMs, "server default")}, ` +
    `idle_in_transaction_session_timeout ${ms(settings.idleInTransactionTimeoutMs, "server default")}`
  );
}

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
