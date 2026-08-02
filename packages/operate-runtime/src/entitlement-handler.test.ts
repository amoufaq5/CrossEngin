import type { HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import { describe, expect, it } from "vitest";

import { buildEntitlementHandler } from "./entitlement-handler.js";
import { InMemoryEntitlementResolver } from "./entitlement.js";

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

describe("buildEntitlementHandler", () => {
  it("returns the active entitlement's plan, cap, and features", async () => {
    const resolver = new InMemoryEntitlementResolver([
      [TENANT, { status: "active", planId: "pro", maxRecordsPerEntity: 5000, features: ["reports", "api"] }],
    ]);
    const out = await buildEntitlementHandler({ resolver })(inputFor(TENANT));
    expect(out.status).toBe(200);
    const body = bodyOf(out);
    expect(body.status).toBe("active");
    expect(body.planId).toBe("pro");
    expect(body.maxRecordsPerEntity).toBe(5000);
    expect(body.features).toEqual(["reports", "api"]);
  });

  it("returns an all-null/empty view for a tenant with no subscription", async () => {
    const resolver = new InMemoryEntitlementResolver();
    const out = await buildEntitlementHandler({ resolver })(inputFor(TENANT));
    expect(out.status).toBe(200);
    const body = bodyOf(out);
    expect(body.status).toBeNull();
    expect(body.planId).toBeNull();
    expect(body.maxRecordsPerEntity).toBeNull();
    expect(body.features).toEqual([]);
  });

  it("fills missing optional plan fields with null/empty", async () => {
    const resolver = new InMemoryEntitlementResolver([[TENANT, { status: "trialing" }]]);
    const out = await buildEntitlementHandler({ resolver })(inputFor(TENANT));
    expect(out.status).toBe(200);
    const body = bodyOf(out);
    expect(body.status).toBe("trialing");
    expect(body.planId).toBeNull();
    expect(body.maxRecordsPerEntity).toBeNull();
    expect(body.features).toEqual([]);
  });

  it("returns 401 tenant_required when the principal has no tenant", async () => {
    const resolver = new InMemoryEntitlementResolver([[TENANT, { status: "active" }]]);
    const out = await buildEntitlementHandler({ resolver })(inputFor(null));
    expect(out.status).toBe(401);
    expect(bodyOf(out).error).toBe("tenant_required");
  });
});
