import type { HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import { describe, expect, it } from "vitest";

import { buildBillingPortalHandler, type BillingCustomerResolver, type BillingPortalCreator } from "./billing-portal-handler.js";

const TENANT = "11111111-1111-1111-1111-111111111111";

function inputFor(tenantId: string | null): HandlerInput {
  return {
    request: {} as HandlerInput["request"],
    route: {} as HandlerInput["route"],
    principal: tenantId === null ? null : ({ tenantId } as HandlerInput["principal"]),
    params: {},
    parsedBody: null,
  };
}

function bodyOf(out: HandlerOutput): Record<string, unknown> {
  return (out as Extract<HandlerOutput, { kind: "json" }>).body as Record<string, unknown>;
}

const customers = (id: string | null): BillingCustomerResolver => ({
  resolveCustomerId: async () => id,
});

const portal = (url: string): BillingPortalCreator => ({
  createBillingPortalSession: async ({ customerId, returnUrl }) => ({ url: `${url}?c=${customerId}&r=${returnUrl}` }),
});

describe("buildBillingPortalHandler", () => {
  it("returns a portal url for a tenant with a Stripe customer", async () => {
    const handler = buildBillingPortalHandler({
      customers: customers("cus_abc"),
      portal: portal("https://billing.stripe.com/s"),
      returnUrl: "https://app/admin/billing",
    });
    const out = await handler(inputFor(TENANT));
    expect(out.status).toBe(200);
    expect(bodyOf(out).url).toBe("https://billing.stripe.com/s?c=cus_abc&r=https://app/admin/billing");
  });

  it("returns 409 no_billing_customer when the tenant has no Stripe customer", async () => {
    const handler = buildBillingPortalHandler({
      customers: customers(null),
      portal: portal("https://x"),
      returnUrl: "https://app/",
    });
    const out = await handler(inputFor(TENANT));
    expect(out.status).toBe(409);
    expect(bodyOf(out).error).toBe("no_billing_customer");
  });

  it("returns 401 tenant_required when the principal has no tenant", async () => {
    const handler = buildBillingPortalHandler({
      customers: customers("cus_abc"),
      portal: portal("https://x"),
      returnUrl: "https://app/",
    });
    expect((await handler(inputFor(null))).status).toBe(401);
  });

  it("maps a portal provider error to 502 billing_portal_unavailable", async () => {
    const handler = buildBillingPortalHandler({
      customers: customers("cus_abc"),
      portal: {
        createBillingPortalSession: async () => {
          throw new Error("stripe down");
        },
      },
      returnUrl: "https://app/",
    });
    const out = await handler(inputFor(TENANT));
    expect(out.status).toBe(502);
    expect(bodyOf(out).error).toBe("billing_portal_unavailable");
    expect(bodyOf(out).detail).toBe("stripe down");
  });
});
