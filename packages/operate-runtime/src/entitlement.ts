import type { Handler, HandlerOutput } from "@crossengin/api-gateway-runtime";

/**
 * Subscription status a tenant can be in. Mirrors `@crossengin/billing`'s
 * `SubscriptionStatus` structurally, so a deployment maps its billing record to this
 * without operate-runtime depending on the billing package (same pattern as the
 * manifest-derived redaction registry).
 */
export type EntitlementStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "paused"
  | "canceled"
  | "unpaid"
  | "incomplete";

export interface Entitlement {
  readonly status: EntitlementStatus;
  /** The plan the tenant is on (for messaging / future limit lookups). */
  readonly planId?: string;
  /** Plan feature flags (reserved for feature-gating; not enforced by status policy). */
  readonly features?: readonly string[];
  /** Per-entity record cap (reserved for quota enforcement; not enforced here yet). */
  readonly maxRecordsPerEntity?: number;
}

/** Whether an operation reads or mutates — drives the read-vs-write grace policy. */
export type OperationKind = "read" | "write";

/** Resolves a tenant's current entitlement (e.g. from a billing store). */
export interface EntitlementResolver {
  resolve(tenantId: string): Promise<Entitlement | null>;
}

export interface EntitlementDecision {
  readonly allowed: boolean;
  /** The status evaluated, absent when the tenant had no entitlement at all. */
  readonly status?: EntitlementStatus;
  /** Machine-readable denial reason, e.g. `subscription_past_due`, `no_subscription`. */
  readonly reason?: string;
}

/**
 * Pure entitlement policy. `active` / `trialing` allow everything. `past_due` is a grace
 * window — reads pass, writes are blocked so the tenant can settle up while still seeing
 * their data. `paused` / `canceled` / `unpaid` / `incomplete` block everything. A null
 * entitlement (no subscription for the tenant) blocks everything.
 */
export function evaluateEntitlement(entitlement: Entitlement | null, op: OperationKind): EntitlementDecision {
  if (entitlement === null) return { allowed: false, reason: "no_subscription" };
  const status = entitlement.status;
  switch (status) {
    case "active":
    case "trialing":
      return { allowed: true, status };
    case "past_due":
      return op === "read" ? { allowed: true, status } : { allowed: false, status, reason: "subscription_past_due" };
    default:
      return { allowed: false, status, reason: `subscription_${status}` };
  }
}

const PROBLEM_TYPE = "https://crossengin.dev/problems/subscription-required";

function detailFor(decision: EntitlementDecision): string {
  switch (decision.reason) {
    case "no_subscription":
      return "This workspace has no active subscription.";
    case "subscription_past_due":
      return "This workspace's subscription is past due; reads are allowed but changes are blocked until payment is settled.";
    default:
      return `This workspace's subscription is ${decision.status ?? "inactive"}.`;
  }
}

/** Builds the RFC 9457 Payment Required (402) problem output for a denied request. */
export function entitlementProblem(decision: EntitlementDecision): HandlerOutput {
  return {
    kind: "json",
    status: 402,
    headers: { "content-type": "application/problem+json" },
    body: {
      type: PROBLEM_TYPE,
      title: "Subscription required",
      status: 402,
      detail: detailFor(decision),
      subscriptionStatus: decision.status ?? null,
      reason: decision.reason ?? "not_entitled",
    },
  };
}

/**
 * Wraps a handler with a subscription entitlement pre-check: resolves the caller tenant's
 * entitlement and, when the policy denies the operation, returns a 402 problem instead of
 * dispatching (the gateway maps the 4xx to a `deny` and halts). An unauthenticated request
 * (no tenant) is passed through untouched — auth/RBAC own that case.
 */
export function withEntitlement(handler: Handler, op: OperationKind, resolver: EntitlementResolver): Handler {
  return async (input) => {
    const tenantId = input.principal?.tenantId ?? null;
    if (tenantId === null) return handler(input);
    const entitlement = await resolver.resolve(tenantId);
    const decision = evaluateEntitlement(entitlement, op);
    if (!decision.allowed) return entitlementProblem(decision);
    return handler(input);
  };
}

/** In-memory `EntitlementResolver` over a tenant → entitlement map (tests / demos / dev). */
export class InMemoryEntitlementResolver implements EntitlementResolver {
  private readonly byTenant: Map<string, Entitlement>;

  constructor(entries?: Iterable<readonly [string, Entitlement]>) {
    this.byTenant = new Map(entries);
  }

  set(tenantId: string, entitlement: Entitlement): this {
    this.byTenant.set(tenantId, entitlement);
    return this;
  }

  async resolve(tenantId: string): Promise<Entitlement | null> {
    return this.byTenant.get(tenantId) ?? null;
  }
}
