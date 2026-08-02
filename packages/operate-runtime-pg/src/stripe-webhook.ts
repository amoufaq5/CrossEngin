import {
  mapStripeSubscription,
  verifyStripeWebhook,
  type StripeWebhookReason,
} from "@crossengin/billing-stripe";
import type { PlanLimitsLookup } from "@crossengin/operate-runtime";

import type { PostgresSubscriptionStore, SubscriptionUpsertRow } from "./subscription-store.js";

/** Deployment-supplied plan catalog: maps a plan/price id to its entitlement limits. */
export type { PlanLimitsLookup } from "@crossengin/operate-runtime";

export interface StripeSubscriptionEventOptions {
  readonly planLimits?: PlanLimitsLookup;
  /** Metadata key on the Stripe subscription carrying the CrossEngin tenant id. */
  readonly tenantMetadataKey?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isoFromUnix(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

/**
 * Pure: maps a parsed Stripe event to a subscription snapshot row, or `null` when the event
 * isn't a `customer.subscription.*` event, isn't a valid subscription, or carries no tenant
 * id (in the subscription's `metadata.<tenantMetadataKey>`, default `tenant_id`). Plan limits
 * (record cap + features) come from the deployment's `planLimits` catalog, falling back to
 * the subscription metadata (`max_records_per_entity`, comma-separated `features`).
 */
export function subscriptionRowFromStripeEvent(
  event: unknown,
  opts: StripeSubscriptionEventOptions = {},
): SubscriptionUpsertRow | null {
  if (!isRecord(event)) return null;
  const type = asString(event["type"]);
  if (type === null || !type.startsWith("customer.subscription.")) return null;
  const data = event["data"];
  if (!isRecord(data)) return null;
  const raw = data["object"];
  if (!isRecord(raw)) return null;

  let mapped;
  try {
    mapped = mapStripeSubscription(raw);
  } catch {
    return null;
  }

  const metadata = isRecord(raw["metadata"]) ? raw["metadata"] : {};
  const tenantId = asString(metadata[opts.tenantMetadataKey ?? "tenant_id"]);
  if (tenantId === null) return null;

  const planId = mapped.priceId ?? asString(metadata["plan_id"]);
  const limits = planId !== null && opts.planLimits !== undefined ? opts.planLimits(planId) : undefined;

  const metaCap = coerceInt(metadata["max_records_per_entity"]);
  const maxRecordsPerEntity = limits?.maxRecordsPerEntity ?? metaCap ?? null;

  const metaFeatures = coerceFeatures(metadata["features"]);
  const features = limits?.features ?? metaFeatures ?? null;

  return {
    tenantId,
    planId,
    status: mapped.status,
    currentPeriodEnd: isoFromUnix(mapped.currentPeriodEnd),
    trialEnd: isoFromUnix(mapped.trialEnd),
    maxRecordsPerEntity,
    features,
    stripeSubscriptionId: asString(raw["id"]),
  };
}

function coerceInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function coerceFeatures(v: unknown): readonly string[] | undefined {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v.trim() !== "") {
    return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return undefined;
}

export interface IngestStripeWebhookInput {
  readonly payload: string;
  readonly signatureHeader: string;
  readonly secret: string;
  readonly store: Pick<PostgresSubscriptionStore, "insert">;
  readonly planLimits?: PlanLimitsLookup;
  readonly tenantMetadataKey?: string;
  readonly now?: Date;
  readonly toleranceSeconds?: number;
}

export type IngestStripeWebhookResult =
  | { readonly ok: false; readonly reason: StripeWebhookReason }
  | { readonly ok: true; readonly applied: false }
  | { readonly ok: true; readonly applied: true; readonly tenantId: string; readonly status: string };

/**
 * The Stripe webhook → `billing_subscriptions` connector: verifies the signature, and when
 * the event is an attributable subscription event, persists a snapshot the
 * `PostgresEntitlementResolver` will read (closing the Stripe → row → gate loop). A verified
 * event that isn't a subscription event, or one with no tenant attribution, is `applied:false`.
 */
export async function ingestStripeWebhook(input: IngestStripeWebhookInput): Promise<IngestStripeWebhookResult> {
  const verified = verifyStripeWebhook(input.payload, input.signatureHeader, input.secret, {
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.toleranceSeconds !== undefined ? { toleranceSeconds: input.toleranceSeconds } : {}),
  });
  if (!verified.valid) return { ok: false, reason: verified.reason ?? "signature_mismatch" };

  const row = subscriptionRowFromStripeEvent(verified.event, {
    ...(input.planLimits !== undefined ? { planLimits: input.planLimits } : {}),
    ...(input.tenantMetadataKey !== undefined ? { tenantMetadataKey: input.tenantMetadataKey } : {}),
  });
  if (row === null) return { ok: true, applied: false };

  await input.store.insert(row);
  return { ok: true, applied: true, tenantId: row.tenantId, status: row.status };
}
