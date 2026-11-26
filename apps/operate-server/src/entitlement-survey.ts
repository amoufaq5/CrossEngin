/**
 * The boot line that says which source gates a tenant's entity routes on its subscription, and what
 * that gate refuses (ADR-0418 Q6, ADR-0482).
 *
 * The subscription gate is opt-in and is armed by a side effect: `--license` with `--license-key`
 * mounts a `LicenseEntitlementResolver`, and a Stripe webhook secret on a Postgres store mounts a
 * `PostgresEntitlementResolver` over `meta.billing_subscriptions`. Neither printed anything, and
 * `evaluateEntitlement` answers **402 `no_subscription` for a null entitlement on reads as well as
 * writes** — so the first operator to set `STRIPE_WEBHOOK_SECRET` learned from a dead deployment that
 * every tenant without a subscription row could no longer read its own data. This line is the
 * diagnosis before the first request rather than after it.
 *
 * Read off the **live resolver** rather than re-derived from the flags (ADR-0361's rule): the
 * license resolver wins over the Stripe one when both are configured, and a second spelling of that
 * precedence here is exactly what would come to disagree with `node.ts`.
 */
import type { EntitlementResolver } from "@crossengin/operate-runtime";
import { LicenseEntitlementResolver } from "@crossengin/operate-runtime";
import { PostgresEntitlementResolver } from "@crossengin/operate-runtime-pg";

export const ENTITLEMENT_GATE_SOURCES = ["none", "license", "stripe_snapshots", "custom"] as const;
export type EntitlementGateSource = (typeof ENTITLEMENT_GATE_SOURCES)[number];

/**
 * Which source a resolver is. `custom` is an embedder-supplied resolver this binary does not
 * construct: it is reported as gating, because it does, and as of unknown policy, because this
 * module cannot see what it answers.
 */
export function entitlementGateSourceOf(resolver: EntitlementResolver | undefined): EntitlementGateSource {
  if (resolver === undefined) return "none";
  if (resolver instanceof LicenseEntitlementResolver) return "license";
  if (resolver instanceof PostgresEntitlementResolver) return "stripe_snapshots";
  return "custom";
}

export interface EntitlementSurveyInput {
  readonly source: EntitlementGateSource;
  /** Whether the Stripe webhook route is mounted, so snapshots are being written either way. */
  readonly stripeWebhookMounted: boolean;
}

/**
 * Whether the source refuses entity requests for some tenant. A total map, so a fifth source is a
 * compile error here rather than a sentence nobody wrote.
 */
export const ENTITLEMENT_SOURCE_GATES: Readonly<Record<EntitlementGateSource, boolean>> = Object.freeze({
  none: false,
  license: true,
  stripe_snapshots: true,
  custom: true,
});

const SOURCE_SENTENCE: Readonly<Record<EntitlementGateSource, string>> = Object.freeze({
  none:
    "subscription gate: off — no --license and no Stripe webhook secret, so entity routes are not gated" +
    " on a subscription",
  license:
    "subscription gate: ON from the license file — only the tenant the license names is admitted;" +
    " every other tenant's entity requests, reads included, answer 402 no_subscription, and an" +
    " expired or invalid license refuses that tenant too",
  stripe_snapshots:
    "subscription gate: ON from Stripe snapshots in meta.billing_subscriptions — a tenant with no row" +
    " there is refused every entity request, reads included (402 no_subscription), and past_due keeps" +
    " reads and refuses writes. The webhook that writes those rows is mounted by the same secret, so" +
    " every tenant Stripe has not yet sent a subscription event for is refused until one arrives;" +
    " unset STRIPE_WEBHOOK_SECRET to disarm the gate",
  custom:
    "subscription gate: ON from a resolver this binary did not construct — its policy is not visible" +
    " here; a null answer is 402 no_subscription for reads and writes",
});

/** The `[entitlement]` boot line. Names sources and codes, never a key or a tenant id. */
export function formatEntitlementSurvey(input: EntitlementSurveyInput): string {
  const head = SOURCE_SENTENCE[input.source];
  if (input.source === "license" && input.stripeWebhookMounted) {
    return (
      `${head}. The Stripe webhook is mounted too and still writes snapshots, but they do not gate` +
      " while a license does"
    );
  }
  return head;
}
