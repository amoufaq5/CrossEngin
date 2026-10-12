/**
 * Where an api-key spec comes from, and what to say when it comes from argv.
 *
 * ADR-0301's rule is that a secret arrives by environment and never argv, because argv is readable
 * via `ps` by any user on the host and by anything that can read `/proc`. An api-key spec is
 * `token:role:tenant[:principal]` and the **token is the credential**, so every `--api-key` on a
 * command line publishes it locally — and `deploy/docker-compose.yml` passed the `--platform-admin`
 * key that way, which is the one credential on the stack that can provision and delete tenants.
 *
 * So this module adds the environment route the flag never had. It does **not** refuse argv, and
 * that split is the decision: ADR-0338 refuses by default because nothing served PHI correctly
 * before it, so a refusal broke nothing that worked; here every existing deployment passes
 * `--api-key` and works, so refusing would break all of them to close an exposure that is local to
 * the host. It warns instead, names the variable, and the shipped compose moves to it.
 *
 * `cli.ts` deliberately reads `process.env` nowhere — it is a pure argv parser — so the merge lives
 * here beside its own variable name, the way `column-encryption.ts` owns
 * `COLUMN_ENCRYPTION_SECRET_VAR`.
 */
import { z } from "zod";

export const API_KEY_SPECS_VAR = "OPERATE_API_KEY_SPECS";

/**
 * Named `_SPECS` rather than `_KEYS` because the value is not a token: it is the whole
 * `token:role:tenant[:principal]` spec that `--api-key` takes. `deploy/` already carries
 * `OPERATE_ADMIN_API_KEY` and `OPERATE_WEB_API_KEY`, which hold bare tokens for a *client* to send,
 * and a reader who confused the two would hand the server a token with no role and no tenant.
 */
export const API_KEY_SPEC_SOURCES = ["none", "argv_only", "env_only", "both"] as const;
export type ApiKeySpecSource = (typeof API_KEY_SPEC_SOURCES)[number];

/**
 * Whether a source puts a credential on the command line. A total map so a fifth source cannot be
 * added without saying which side of ADR-0301 it falls on.
 */
export const SOURCE_EXPOSES_ARGV: Readonly<Record<ApiKeySpecSource, boolean>> = Object.freeze({
  none: false,
  argv_only: true,
  env_only: false,
  both: true,
});

export const ApiKeySpecResolutionSchema = z.object({
  /** Every spec, argv first, in the order a caller gave them. */
  specs: z.array(z.string().min(1)).readonly(),
  source: z.enum(API_KEY_SPEC_SOURCES),
  fromArgv: z.number().int().nonnegative(),
  fromEnv: z.number().int().nonnegative(),
});
export type ApiKeySpecResolution = z.infer<typeof ApiKeySpecResolutionSchema>;

/**
 * Splits on newline **and** comma, because the two deployment shapes need different ones: a compose
 * `environment:` block takes a multi-line value cleanly while a `.env` file does not, and neither
 * character can occur inside a spec — a token, a role and a UUID are all colon-delimited and
 * comma-free, so there is no value this makes ambiguous.
 */
function splitSpecs(raw: string): readonly string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Both sources are read and **concatenated** rather than one overriding the other. Precedence would
 * mean a deployment that set the variable and forgot to remove the flag silently served only one
 * set of credentials, and which set depends on a rule nobody reads; concatenating makes the
 * configuration the union of what was asked for, and the `both` verdict is what says so out loud.
 */
export function resolveApiKeySpecs(
  argvSpecs: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ApiKeySpecResolution {
  const envSpecs = splitSpecs(env[API_KEY_SPECS_VAR] ?? "");
  const source: ApiKeySpecSource =
    argvSpecs.length > 0 && envSpecs.length > 0
      ? "both"
      : argvSpecs.length > 0
        ? "argv_only"
        : envSpecs.length > 0
          ? "env_only"
          : "none";
  return ApiKeySpecResolutionSchema.parse({
    specs: [...argvSpecs, ...envSpecs],
    source,
    fromArgv: argvSpecs.length,
    fromEnv: envSpecs.length,
  });
}

/**
 * The boot line, affirmative in both directions: "we checked and found nothing" cannot be claimed
 * from the absence of a log line, so a deployment that moved its credentials to the environment is
 * told that it did.
 */
export function formatApiKeySpecSource(resolution: ApiKeySpecResolution): string {
  const { source, fromArgv, fromEnv } = resolution;
  const counts = `${fromArgv.toString()} from argv, ${fromEnv.toString()} from ${API_KEY_SPECS_VAR}`;
  if (source === "none") return "api-key specs: none declared";
  if (!SOURCE_EXPOSES_ARGV[source]) return `api-key specs: ${counts} — none on the command line`;
  return (
    `api-key specs: ${counts} — a spec's token IS the credential and argv is readable via \`ps\`, ` +
    `so move it to ${API_KEY_SPECS_VAR} (newline- or comma-separated)`
  );
}
