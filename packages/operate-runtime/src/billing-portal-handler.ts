import type { Handler, HandlerOutput } from "@crossengin/api-gateway-runtime";

/** Resolves a tenant's Stripe customer id (e.g. from the persisted subscription snapshot). */
export interface BillingCustomerResolver {
  resolveCustomerId(tenantId: string): Promise<string | null>;
}

/** Creates a hosted Billing Portal session for a customer (e.g. the Stripe client). */
export interface BillingPortalCreator {
  createBillingPortalSession(input: {
    readonly customerId: string;
    readonly returnUrl: string;
  }): Promise<{ readonly url: string }>;
}

export interface BillingPortalHandlerContext {
  readonly customers: BillingCustomerResolver;
  readonly portal: BillingPortalCreator;
  /** Where Stripe returns the customer after they finish in the portal. */
  readonly returnUrl: string;
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

/**
 * `POST /v1/meta/billing-portal` — mints a Stripe Billing Portal session for the caller
 * tenant and returns its `{url}` for the console to redirect to. Ungated (own tenant only,
 * like the entitlement route) so a *lapsed* tenant can reach the portal to fix payment. A
 * tenant with no Stripe customer (offline/manual) gets a 409 `no_billing_customer`; a portal
 * provider error becomes a 502 `billing_portal_unavailable` rather than a raw 500.
 */
export function buildBillingPortalHandler(ctx: BillingPortalHandlerContext): Handler {
  return async ({ principal }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required" });
    const customerId = await ctx.customers.resolveCustomerId(tenantId);
    if (customerId === null) return json(409, { error: "no_billing_customer" });
    try {
      const session = await ctx.portal.createBillingPortalSession({ customerId, returnUrl: ctx.returnUrl });
      return json(200, { url: session.url });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown error";
      return json(502, { error: "billing_portal_unavailable", detail });
    }
  };
}
