/**
 * Where the two Stripe secrets come from.
 *
 * `--stripe-api-key` and `--stripe-webhook-secret` were the **only** route for a Stripe secret key
 * and a webhook signing secret, so a deployment using either published it on the host's process
 * list — argv is readable by anyone who can run `ps`, which is ADR-0301's rule and the reason
 * `OPERATE_API_KEY_SPECS` exists (ADR-0357). This is that route for these two.
 *
 * Two sources are admissible **iff they state the same secret**, which is ADR-0406's rule for the
 * audit-chain keypair and not ADR-0357's concatenation: a secret is one value and not a list, so a
 * deployment that set the variable and forgot the flag would otherwise serve one of two keys, and
 * which one would depend on a precedence rule nobody reads.
 *
 * Nothing here prints a value; a refusal names the variable and the flag and nothing else.
 */

export const STRIPE_API_KEY_VAR = "STRIPE_API_KEY";
export const STRIPE_WEBHOOK_SECRET_VAR = "STRIPE_WEBHOOK_SECRET";

export const STRIPE_SECRET_SOURCES = ["absent", "flag_only", "env_only", "both"] as const;
export type StripeSecretSource = (typeof STRIPE_SECRET_SOURCES)[number];

/** Whether a source puts the secret on argv. A total map, so a fifth source is a compile error. */
export const STRIPE_SOURCE_EXPOSES_ARGV: Readonly<Record<StripeSecretSource, boolean>> =
  Object.freeze({ absent: false, flag_only: true, env_only: false, both: true });

export interface ResolvedStripeSecret {
  readonly value: string | null;
  readonly source: StripeSecretSource;
}

export interface StripeSecrets {
  readonly apiKey: ResolvedStripeSecret;
  readonly webhookSecret: ResolvedStripeSecret;
}

export class StripeSecretsRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeSecretsRefused";
  }
}

function resolveOne(
  flag: string | null,
  envValue: string | undefined,
  flagName: string,
  varName: string,
): ResolvedStripeSecret {
  const fromFlag = flag !== null && flag.trim() !== "" ? flag.trim() : null;
  const fromEnv = envValue !== undefined && envValue.trim() !== "" ? envValue.trim() : null;
  if (fromFlag === null && fromEnv === null) return { value: null, source: "absent" };
  if (fromFlag === null) return { value: fromEnv, source: "env_only" };
  if (fromEnv === null) return { value: fromFlag, source: "flag_only" };
  if (fromFlag !== fromEnv) {
    throw new StripeSecretsRefused(
      `${flagName} and ${varName} are both set and differ; one deployment holds one secret, so` +
        ` set exactly one (prefer ${varName}: argv is readable by anyone who can run ps)`,
    );
  }
  return { value: fromFlag, source: "both" };
}

export interface ResolveStripeSecretsInput {
  readonly flagApiKey: string | null;
  readonly flagWebhookSecret: string | null;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function resolveStripeSecrets(input: ResolveStripeSecretsInput): StripeSecrets {
  return {
    apiKey: resolveOne(input.flagApiKey, input.env[STRIPE_API_KEY_VAR], "--stripe-api-key", STRIPE_API_KEY_VAR),
    webhookSecret: resolveOne(
      input.flagWebhookSecret,
      input.env[STRIPE_WEBHOOK_SECRET_VAR],
      "--stripe-webhook-secret",
      STRIPE_WEBHOOK_SECRET_VAR,
    ),
  };
}

/**
 * Whether the operator named the secret on **this** binary's command line. The two "nothing would
 * use it" refusals keep their parse-time meaning only for a flag: a variable in the environment may
 * be there for a sibling service (the `COLUMN_ENCRYPTION_SECRET` precedent, ADR-0338), and before
 * this binary read it a deployment carrying one booted — so refusing it would refuse a deployment
 * that works. An unused variable is a warning instead (`stripeUnusedSecretWarnings`).
 */
const SOURCE_IS_A_FLAG: Readonly<Record<StripeSecretSource, boolean>> = Object.freeze({
  absent: false,
  flag_only: true,
  env_only: false,
  both: true,
});

export interface StripeRequirementInput {
  readonly secrets: StripeSecrets;
  readonly store: "memory" | "pg" | "pg-columns";
  readonly planCatalogFile: string | null;
  readonly billingPortalReturnUrl: string | null;
  readonly stripeUsageSyncConfig: string | null;
}

/**
 * The cross-checks that used to run at parse, over the **resolved** secrets. At parse time only the
 * flags are visible (the CLI reads no environment, by design), so a check there refused a
 * deployment supplying the secret through the environment. Returns the first refusal, or null.
 */
export function stripeRequirementRefusal(input: StripeRequirementInput): string | null {
  const { apiKey, webhookSecret } = input.secrets;
  if (SOURCE_IS_A_FLAG[webhookSecret.source] && input.store === "memory") {
    return "--stripe-webhook-secret requires a Postgres store (--store pg or pg-columns)";
  }
  if (SOURCE_IS_A_FLAG[apiKey.source] && input.store === "memory") {
    return "--stripe-api-key requires a Postgres store (--store pg or pg-columns)";
  }
  if (input.planCatalogFile !== null && webhookSecret.value === null) {
    return (
      `--plan-catalog requires a Stripe webhook secret (${STRIPE_WEBHOOK_SECRET_VAR} or` +
      " --stripe-webhook-secret): it feeds webhook record caps"
    );
  }
  if (input.stripeUsageSyncConfig !== null && apiKey.value === null) {
    return `--stripe-usage-sync-config requires a Stripe API key (${STRIPE_API_KEY_VAR} or --stripe-api-key)`;
  }
  if (
    SOURCE_IS_A_FLAG[apiKey.source] &&
    input.billingPortalReturnUrl === null &&
    input.stripeUsageSyncConfig === null
  ) {
    return (
      "--stripe-api-key is set and nothing would use it: pass --billing-portal-return-url or" +
      " --stripe-usage-sync-config"
    );
  }
  return null;
}

/** The warnings for a secret set only in the environment that this deployment will not use. */
export function stripeUnusedSecretWarnings(input: StripeRequirementInput): readonly string[] {
  const { apiKey, webhookSecret } = input.secrets;
  const out: string[] = [];
  if (webhookSecret.source === "env_only" && input.store === "memory") {
    out.push(
      `${STRIPE_WEBHOOK_SECRET_VAR} is set and unused: the Stripe webhook needs a Postgres store, so it is not mounted`,
    );
  }
  if (apiKey.source === "env_only") {
    if (input.store === "memory") {
      out.push(`${STRIPE_API_KEY_VAR} is set and unused: billing needs a Postgres store`);
    } else if (input.billingPortalReturnUrl === null && input.stripeUsageSyncConfig === null) {
      out.push(
        `${STRIPE_API_KEY_VAR} is set and unused: pass --billing-portal-return-url or` +
          " --stripe-usage-sync-config to use it",
      );
    }
  }
  return out;
}

/** The boot line, or null when neither secret is configured. Never prints a value. */
export function formatStripeSecrets(secrets: StripeSecrets): string | null {
  const parts: string[] = [];
  const named: [string, string, ResolvedStripeSecret][] = [
    ["api key", STRIPE_API_KEY_VAR, secrets.apiKey],
    ["webhook secret", STRIPE_WEBHOOK_SECRET_VAR, secrets.webhookSecret],
  ];
  for (const [label, varName, s] of named) {
    if (s.source === "absent") continue;
    parts.push(
      STRIPE_SOURCE_EXPOSES_ARGV[s.source]
        ? `${label} from argv (${s.source}) — readable via ps; move it to ${varName}`
        : `${label} from ${varName}`,
    );
  }
  return parts.length === 0 ? null : `[stripe] ${parts.join("; ")}`;
}
