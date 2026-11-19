import { describe, expect, it } from "vitest";

import {
  STRIPE_API_KEY_VAR,
  STRIPE_SECRET_SOURCES,
  STRIPE_SOURCE_EXPOSES_ARGV,
  STRIPE_WEBHOOK_SECRET_VAR,
  StripeSecretsRefused,
  formatStripeSecrets,
  resolveStripeSecrets,
  stripeRequirementRefusal,
  stripeUnusedSecretWarnings,
  type StripeSecrets,
} from "./stripe-secret-source.js";

// Built by interpolation so no secret-shaped literal sits in the tree (ADR-0420).
const KEY_A = ["sk", "test", "a".repeat(24)].join("_");
const KEY_B = ["sk", "test", "b".repeat(24)].join("_");
const HOOK = ["whsec", "c".repeat(32)].join("_");

describe("resolveStripeSecrets", () => {
  it("reads either source alone and says which", () => {
    const env = resolveStripeSecrets({
      flagApiKey: null,
      flagWebhookSecret: null,
      env: { [STRIPE_API_KEY_VAR]: KEY_A, [STRIPE_WEBHOOK_SECRET_VAR]: HOOK },
    });
    expect(env.apiKey).toEqual({ value: KEY_A, source: "env_only" });
    expect(env.webhookSecret).toEqual({ value: HOOK, source: "env_only" });
    const flag = resolveStripeSecrets({ flagApiKey: KEY_A, flagWebhookSecret: null, env: {} });
    expect(flag.apiKey).toEqual({ value: KEY_A, source: "flag_only" });
    expect(flag.webhookSecret).toEqual({ value: null, source: "absent" });
  });

  it("admits both sources only when they state the same secret", () => {
    const same = resolveStripeSecrets({
      flagApiKey: KEY_A,
      flagWebhookSecret: null,
      env: { [STRIPE_API_KEY_VAR]: KEY_A },
    });
    expect(same.apiKey.source).toBe("both");
    expect(() =>
      resolveStripeSecrets({ flagApiKey: KEY_A, flagWebhookSecret: null, env: { [STRIPE_API_KEY_VAR]: KEY_B } }),
    ).toThrow(StripeSecretsRefused);
  });

  it("never names a value in its refusal", () => {
    try {
      resolveStripeSecrets({ flagApiKey: KEY_A, flagWebhookSecret: null, env: { [STRIPE_API_KEY_VAR]: KEY_B } });
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain(STRIPE_API_KEY_VAR);
      expect(message).not.toContain(KEY_A);
      expect(message).not.toContain(KEY_B);
    }
  });

  it("treats an empty or whitespace variable as unset", () => {
    const r = resolveStripeSecrets({ flagApiKey: null, flagWebhookSecret: null, env: { [STRIPE_API_KEY_VAR]: "  " } });
    expect(r.apiKey.source).toBe("absent");
  });
});

function secrets(apiKey: string | null, webhookSecret: string | null): StripeSecrets {
  return resolveStripeSecrets({ flagApiKey: null, flagWebhookSecret: null, env: {
    ...(apiKey !== null ? { [STRIPE_API_KEY_VAR]: apiKey } : {}),
    ...(webhookSecret !== null ? { [STRIPE_WEBHOOK_SECRET_VAR]: webhookSecret } : {}),
  } });
}

describe("stripeRequirementRefusal", () => {
  const base = { store: "pg" as const, planCatalogFile: null, billingPortalReturnUrl: null, stripeUsageSyncConfig: null };

  it("admits an environment-only deployment the parse-time check used to refuse", () => {
    expect(
      stripeRequirementRefusal({ ...base, secrets: secrets(null, HOOK), planCatalogFile: "plans.json" }),
    ).toBeNull();
    expect(
      stripeRequirementRefusal({ ...base, secrets: secrets(KEY_A, null), stripeUsageSyncConfig: "sync.json" }),
    ).toBeNull();
  });

  it("refuses each requirement over the resolved secrets", () => {
    expect(stripeRequirementRefusal({ ...base, secrets: secrets(null, null), planCatalogFile: "p.json" })).toMatch(
      /--plan-catalog requires/,
    );
    expect(
      stripeRequirementRefusal({ ...base, secrets: secrets(null, null), stripeUsageSyncConfig: "s.json" }),
    ).toMatch(/--stripe-usage-sync-config requires/);
  });

  it("keeps the unused-secret refusals for a flag, which the operator named on this command line", () => {
    const flagged = (apiKey: string | null, hook: string | null): StripeSecrets =>
      resolveStripeSecrets({ flagApiKey: apiKey, flagWebhookSecret: hook, env: {} });
    expect(stripeRequirementRefusal({ ...base, secrets: flagged(null, HOOK), store: "memory" })).toMatch(
      /--stripe-webhook-secret requires a Postgres store/,
    );
    expect(stripeRequirementRefusal({ ...base, secrets: flagged(KEY_A, null), store: "memory" })).toMatch(
      /--stripe-api-key requires a Postgres store/,
    );
    expect(stripeRequirementRefusal({ ...base, secrets: flagged(KEY_A, null) })).toMatch(/nothing would use it/);
    expect(
      stripeRequirementRefusal({ ...base, secrets: flagged(KEY_A, null), billingPortalReturnUrl: "https://x" }),
    ).toBeNull();
  });

  it("does not refuse a variable set only in the environment that this deployment will not use", () => {
    // Before this binary read STRIPE_*, a deployment carrying them booted; the variable may be set
    // for a sibling service. Refusing it would refuse a deployment that works (ADR-0338).
    expect(stripeRequirementRefusal({ ...base, secrets: secrets(null, HOOK), store: "memory" })).toBeNull();
    expect(stripeRequirementRefusal({ ...base, secrets: secrets(KEY_A, null), store: "memory" })).toBeNull();
    expect(stripeRequirementRefusal({ ...base, secrets: secrets(KEY_A, null) })).toBeNull();
  });
});

describe("stripeUnusedSecretWarnings", () => {
  const base = { store: "pg" as const, planCatalogFile: null, billingPortalReturnUrl: null, stripeUsageSyncConfig: null };

  it("warns, naming the variable and never the value, for an environment secret nothing uses", () => {
    const memory = stripeUnusedSecretWarnings({ ...base, secrets: secrets(KEY_A, HOOK), store: "memory" });
    expect(memory).toHaveLength(2);
    expect(memory.join(" ")).toContain(STRIPE_WEBHOOK_SECRET_VAR);
    expect(memory.join(" ")).toContain(STRIPE_API_KEY_VAR);
    const pg = stripeUnusedSecretWarnings({ ...base, secrets: secrets(KEY_A, null) });
    expect(pg).toEqual([expect.stringContaining("--billing-portal-return-url")]);
    for (const line of [...memory, ...pg]) {
      expect(line).not.toContain(KEY_A);
      expect(line).not.toContain(HOOK);
    }
  });

  it("is silent when the secret is used, and for a flag, which refuses instead", () => {
    expect(stripeUnusedSecretWarnings({ ...base, secrets: secrets(null, HOOK) })).toEqual([]);
    expect(
      stripeUnusedSecretWarnings({ ...base, secrets: secrets(KEY_A, null), billingPortalReturnUrl: "https://x" }),
    ).toEqual([]);
    expect(
      stripeUnusedSecretWarnings({
        ...base,
        secrets: resolveStripeSecrets({ flagApiKey: KEY_A, flagWebhookSecret: null, env: {} }),
      }),
    ).toEqual([]);
  });
});

describe("formatStripeSecrets", () => {
  it("is silent with neither, names argv exposure, and prints no value", () => {
    expect(formatStripeSecrets(secrets(null, null))).toBeNull();
    const flagged = resolveStripeSecrets({ flagApiKey: KEY_A, flagWebhookSecret: null, env: { [STRIPE_WEBHOOK_SECRET_VAR]: HOOK } });
    const line = formatStripeSecrets(flagged) ?? "";
    expect(line).toContain("readable via ps");
    expect(line).toContain(`webhook secret from ${STRIPE_WEBHOOK_SECRET_VAR}`);
    expect(line).not.toContain(KEY_A);
    expect(line).not.toContain(HOOK);
  });

  it("maps every source to an argv answer", () => {
    expect(Object.keys(STRIPE_SOURCE_EXPOSES_ARGV).sort()).toEqual([...STRIPE_SECRET_SOURCES].sort());
  });
});
