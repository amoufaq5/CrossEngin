import { isTenantPseudonym } from "@crossengin/ai-providers";
import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";

import {
  AI_TENANT_PSEUDONYM_SECRET_VAR,
  resolveAiTenantPseudonymSource,
} from "./ai-tenant-pseudonym.js";
import { CliUsageError } from "./cli.js";

/**
 * `operate-server ai-pseudonym-lookup <ctp_…>` — which tenant a vendor's abuse report is about
 * (ADR-0461, closing ADR-0456's open question).
 *
 * A provider that flags a request can only name it by the pseudonym it was sent, and the pseudonym
 * is a keyed one-way derivation (`HKDF(CURSOR_ENCRYPTION_SECRET, salt = tenantId)`), so nothing
 * inverts it. What the deployment can do, and nobody else can, is recompute it for every tenant id
 * and compare. This command is that, so an operator does not do it by hand.
 *
 * ## Three rules it inherits
 *
 * The secret comes from the **environment** and never argv (ADR-0301), and is resolved by the very
 * function the serving process uses — `resolveAiTenantPseudonymSource(env, "keyed")` — so the
 * command and the server cannot disagree about what the secret is or whether it is usable. A
 * rotated secret gives every tenant a new pseudonym (ADR-0456), so a report older than the rotation
 * answers `no_match`, and the report says so rather than leaving it to be inferred.
 *
 * The comparison is over `id::text`, which Postgres renders lowercase, and that matches because the
 * mapping lowercases a uuid-shaped tenant id before deriving (`canonicalTenantIdForPseudonym`) — so
 * a credential that spelled its tenant in uppercase is derived as the row's own spelling.
 *
 * Every tenant **status** is read, `deleted` included: retirement is `UPDATE … SET status`, the row
 * survives, and a vendor report about a tenant since deleted is exactly the case an operator most
 * needs answered.
 *
 * A read that RLS would confine is **refused**, not answered. `meta.tenants` carries no RLS and no
 * policy today, so `crossengin_app` reads every row; but a confined read of this table returns
 * fewer rows with no error, and `no_match` over a confined read is a false negative that looks like
 * an answer (ADR-0333's silent zero). So Postgres is asked — `row_security_active`, its own verdict
 * (ADR-0362) — before anything is compared.
 */

export const AI_PSEUDONYM_LOOKUP_OUTCOMES = [
  "match",
  "no_match",
  "ambiguous",
  "secret_absent",
  "secret_refused",
  "read_confined",
] as const;
export type AiPseudonymLookupOutcome = (typeof AI_PSEUDONYM_LOOKUP_OUTCOMES)[number];

/**
 * Only a single match is an answer. A map rather than `=== "match"`, so a seventh outcome is a
 * compile error here instead of a value that silently exits 1 (or 0).
 */
export const AI_PSEUDONYM_LOOKUP_ANSWERED: Readonly<
  Record<"match", true> & Record<Exclude<AiPseudonymLookupOutcome, "match">, false>
> = Object.freeze({
  match: true,
  no_match: false,
  ambiguous: false,
  secret_absent: false,
  secret_refused: false,
  read_confined: false,
});

export interface AiPseudonymLookupOptions {
  readonly pseudonym: string | null;
  readonly schema: string | null;
  readonly format: "human" | "json";
  readonly help: boolean;
}

export interface LookupTenant {
  readonly id: string;
  readonly slug: string;
  readonly status: string;
}

export interface AiPseudonymLookupReport {
  readonly outcome: AiPseudonymLookupOutcome;
  readonly pseudonym: string;
  /** The matching tenants: one on `match`, two or more on `ambiguous`, none otherwise. */
  readonly tenants: readonly LookupTenant[];
  /** How many `meta.tenants` rows were compared; `null` when the table was never read. */
  readonly examined: number | null;
  readonly detail: string;
  readonly ok: boolean;
}

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export function parseAiPseudonymLookupArgs(argv: readonly string[]): AiPseudonymLookupOptions {
  let pseudonym: string | null = null;
  let schema: string | null = null;
  let format: "human" | "json" = "human";
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = argv[i + 1];
    const inline = arg.includes("=");
    const value = (flag: string): string => {
      const v = inline ? arg.slice(arg.indexOf("=") + 1) : next;
      if (v === undefined || v.length === 0) throw new CliUsageError(`${flag} requires a value`);
      return v;
    };
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--schema" || arg.startsWith("--schema=")) {
      const raw = value("--schema");
      if (!SCHEMA_PATTERN.test(raw)) throw new CliUsageError(`invalid --schema: ${raw}`);
      schema = raw;
      if (!inline) i += 1;
    } else if (arg === "--format" || arg.startsWith("--format=")) {
      const raw = value("--format");
      if (raw !== "human" && raw !== "json") {
        throw new CliUsageError(`invalid --format: ${raw} (human|json)`);
      }
      format = raw;
      if (!inline) i += 1;
    } else if (arg === "--secret" || arg.startsWith("--secret=")) {
      // Named so the refusal can say why, rather than "unknown option".
      throw new CliUsageError(
        `--secret is deliberately not an option: a secret on argv is readable by anyone who can` +
          ` run 'ps'. Set ${AI_TENANT_PSEUDONYM_SECRET_VAR} in the environment instead.`,
      );
    } else if (arg.startsWith("-")) {
      throw new CliUsageError(`unknown option for ai-pseudonym-lookup: ${arg}`);
    } else {
      if (pseudonym !== null) {
        throw new CliUsageError("ai-pseudonym-lookup takes exactly one pseudonym");
      }
      pseudonym = arg;
    }
  }

  if (help) return { pseudonym, schema, format, help: true };
  if (pseudonym === null) {
    throw new CliUsageError("ai-pseudonym-lookup requires a pseudonym (ctp_<32 lowercase hex>)");
  }
  // Refused before any connection: a value of another shape cannot be one this deployment sent, and
  // the message does not quote it, because what an operator pastes here may be a raw identifier.
  if (!isTenantPseudonym(pseudonym)) {
    throw new CliUsageError(
      "not a tenant pseudonym: expected ctp_ followed by 32 lowercase hex characters, which is the" +
        " only shape this deployment sends a provider (ADR-0456)",
    );
  }
  return { pseudonym, schema, format, help: false };
}

/**
 * The comparison itself, pure. Every tenant is derived and compared — no early return on the first
 * match — so a second match is reported as `ambiguous` rather than hidden behind the first.
 */
export function matchAiTenantPseudonym(
  pseudonym: string,
  pseudonymFor: (tenantId: string) => string,
  tenants: readonly LookupTenant[],
): readonly LookupTenant[] {
  return tenants.filter((t) => pseudonymFor(t.id) === pseudonym);
}

export type AiPseudonymLookupConnect = (env: Readonly<Record<string, string | undefined>>) => PgConnection;

const defaultConnect: AiPseudonymLookupConnect = (env) => createNodePgConnection(parsePgEnvConfig(env));

export async function runAiPseudonymLookup(
  options: AiPseudonymLookupOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
  connect: AiPseudonymLookupConnect = defaultConnect,
): Promise<AiPseudonymLookupReport> {
  const pseudonym = options.pseudonym ?? "";
  let pseudonymFor: (tenantId: string) => string;
  try {
    const source = resolveAiTenantPseudonymSource(env, "keyed");
    if (source.kind !== "keyed") {
      return refused(
        "secret_absent",
        pseudonym,
        null,
        `${AI_TENANT_PSEUDONYM_SECRET_VAR} is unset or empty; set it to the value the server runs ` +
          "with (it is read from the environment, never argv)",
      );
    }
    pseudonymFor = source.pseudonymFor;
  } catch (err) {
    // The refusal names the reason (too_short / too_uniform) and never the value.
    return refused("secret_refused", pseudonym, null, (err as Error).message);
  }

  const schema = options.schema ?? "meta";
  if (!SCHEMA_PATTERN.test(schema)) throw new CliUsageError(`invalid --schema: ${schema}`);
  const conn = connect(env);
  try {
    const probe = await conn.query<{ confined: boolean }>(
      `SELECT row_security_active('${schema}.tenants'::regclass) AS confined`,
    );
    if (probe.rows[0]?.confined !== false) {
      return refused(
        "read_confined",
        pseudonym,
        null,
        `row-level security would confine this session's read of ${schema}.tenants, so a miss ` +
          "could not be told from a tenant this role cannot see; run as a role that reads every " +
          "tenant (the catalog owner), or as one RLS does not confine",
      );
    }
    const result = await conn.query<LookupTenant>(
      `SELECT id::text AS id, slug, status FROM ${schema}.tenants ORDER BY id`,
    );
    const examined = result.rows.length;
    const matches = matchAiTenantPseudonym(pseudonym, pseudonymFor, result.rows);
    if (matches.length === 1) {
      return {
        outcome: "match",
        pseudonym,
        tenants: matches,
        examined,
        detail: `derived from ${AI_TENANT_PSEUDONYM_SECRET_VAR} for exactly one of ${examined.toString()} tenant(s)`,
        ok: true,
      };
    }
    if (matches.length > 1) {
      return {
        outcome: "ambiguous",
        pseudonym,
        tenants: matches,
        examined,
        detail:
          `${matches.length.toString()} tenants derive this pseudonym, which a 128-bit derivation ` +
          "should never produce; none is chosen",
        ok: false,
      };
    }
    return refused(
      "no_match",
      pseudonym,
      examined,
      `no tenant among ${examined.toString()} derives this pseudonym under this ` +
        `${AI_TENANT_PSEUDONYM_SECRET_VAR}. What this cannot rule out: the secret was rotated since ` +
        "the report, so only the previous value can match it; the request came from a credential " +
        "whose tenant has no meta.tenants row (an api-key tenant with --tenant-status-gate off), " +
        "which nothing here can enumerate; or the server that sent it predates ADR-0461, which " +
        "derived over the credential's spelling of the tenant id rather than its lowercase form",
    );
  } finally {
    await conn.close();
  }
}

function refused(
  outcome: Exclude<AiPseudonymLookupOutcome, "match" | "ambiguous">,
  pseudonym: string,
  examined: number | null,
  detail: string,
): AiPseudonymLookupReport {
  return {
    outcome,
    pseudonym,
    tenants: [],
    examined,
    detail,
    ok: AI_PSEUDONYM_LOOKUP_ANSWERED[outcome],
  };
}

/** Never prints the secret or a derived key — only the pseudonym the operator gave and the tenant. */
export function formatAiPseudonymLookupReport(report: AiPseudonymLookupReport): string {
  const head =
    report.outcome === "match"
      ? "ai-pseudonym-lookup: match"
      : `ai-pseudonym-lookup: ${report.outcome}`;
  const lines = [head, `  pseudonym: ${report.pseudonym}`];
  for (const t of report.tenants) {
    lines.push(`  tenant:    ${t.id} (slug ${t.slug}, status ${t.status})`);
  }
  if (report.examined !== null) lines.push(`  examined:  ${report.examined.toString()} tenant(s)`);
  lines.push(`  detail:    ${report.detail}`);
  return lines.join("\n");
}

export const aiPseudonymLookupHelpText = `operate-server ai-pseudonym-lookup — which tenant an AI provider's report names

Usage:
  operate-server ai-pseudonym-lookup <ctp_…> [options]

An AI provider is sent an opaque per-tenant pseudonym (ctp_<32 hex>) instead of the tenant id
(ADR-0456). When a provider reports a flagged request it can only name that pseudonym. This
recomputes the pseudonym for every row of meta.tenants, every status included, and prints the one
that matches.

${AI_TENANT_PSEUDONYM_SECRET_VAR} is read from the environment and never argv; it must be the value
the server ran with when the request was sent. The secret is never printed. The output pairs a
pseudonym with a tenant id, which is the join the derivation denies the provider: keep it out of
anything that goes back to the vendor.

Runs as the serving role (crossengin_app): meta.tenants carries no row-level security. A read that
RLS would confine is refused rather than answered, so a miss is never a tenant this role cannot see.

Options:
  --schema <name>        Meta-schema name (default meta)
  --format human|json    Output format (default human)

Exit: 0 on exactly one match; 1 on no match, an ambiguous match, or a refusal (secret absent or
refused, confined read); 2 on a usage error, including a malformed pseudonym.
`;
