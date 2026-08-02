import type { Handler, HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import { describe, expect, it } from "vitest";

import {
  InMemoryEntitlementResolver,
  evaluateEntitlement,
  entitlementProblem,
  withEntitlement,
  withRecordLimit,
  type Entitlement,
} from "./entitlement.js";
import { InMemoryEntityStore } from "./store.js";

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

const ok: Handler = () => ({ kind: "json", status: 200, body: { ok: true } });

describe("evaluateEntitlement", () => {
  const ent = (status: Entitlement["status"]): Entitlement => ({ status });

  it("allows reads and writes for active / trialing", () => {
    for (const s of ["active", "trialing"] as const) {
      expect(evaluateEntitlement(ent(s), "read").allowed).toBe(true);
      expect(evaluateEntitlement(ent(s), "write").allowed).toBe(true);
    }
  });

  it("past_due allows reads but blocks writes (grace)", () => {
    expect(evaluateEntitlement(ent("past_due"), "read")).toMatchObject({ allowed: true, status: "past_due" });
    expect(evaluateEntitlement(ent("past_due"), "write")).toMatchObject({ allowed: false, reason: "subscription_past_due" });
  });

  it("blocks everything for paused / canceled / unpaid / incomplete", () => {
    for (const s of ["paused", "canceled", "unpaid", "incomplete"] as const) {
      expect(evaluateEntitlement(ent(s), "read").allowed).toBe(false);
      expect(evaluateEntitlement(ent(s), "write")).toMatchObject({ allowed: false, reason: `subscription_${s}` });
    }
  });

  it("blocks a tenant with no subscription", () => {
    expect(evaluateEntitlement(null, "read")).toMatchObject({ allowed: false, reason: "no_subscription" });
  });
});

describe("entitlementProblem", () => {
  it("is a 402 problem+json envelope carrying the status + reason", () => {
    const out = entitlementProblem({ allowed: false, status: "canceled", reason: "subscription_canceled" });
    expect(out.status).toBe(402);
    expect(out.headers?.["content-type"]).toBe("application/problem+json");
    const body = (out as Extract<HandlerOutput, { kind: "json" }>).body as Record<string, unknown>;
    expect(body.subscriptionStatus).toBe("canceled");
    expect(body.reason).toBe("subscription_canceled");
    expect(body.status).toBe(402);
  });
});

describe("withEntitlement", () => {
  it("passes an allowed request through to the handler", async () => {
    const resolver = new InMemoryEntitlementResolver([[TENANT, { status: "active" }]]);
    const gated = withEntitlement(ok, "write", resolver);
    expect(await gated(inputFor(TENANT))).toMatchObject({ status: 200 });
  });

  it("returns 402 for a lapsed tenant without calling the handler", async () => {
    let called = false;
    const spy: Handler = () => {
      called = true;
      return { kind: "json", status: 200, body: {} };
    };
    const resolver = new InMemoryEntitlementResolver([[TENANT, { status: "canceled" }]]);
    const out = await withEntitlement(spy, "write", resolver)(inputFor(TENANT));
    expect(out.status).toBe(402);
    expect(called).toBe(false);
  });

  it("blocks a write but allows a read for a past_due tenant", async () => {
    const resolver = new InMemoryEntitlementResolver([[TENANT, { status: "past_due" }]]);
    expect((await withEntitlement(ok, "read", resolver)(inputFor(TENANT))).status).toBe(200);
    expect((await withEntitlement(ok, "write", resolver)(inputFor(TENANT))).status).toBe(402);
  });

  it("returns 402 when the tenant has no entitlement at all", async () => {
    const resolver = new InMemoryEntitlementResolver();
    expect((await withEntitlement(ok, "read", resolver)(inputFor(TENANT))).status).toBe(402);
  });

  it("passes an unauthenticated request through (auth owns that case)", async () => {
    const resolver = new InMemoryEntitlementResolver();
    expect((await withEntitlement(ok, "write", resolver)(inputFor(null))).status).toBe(200);
  });
});

describe("withRecordLimit (plan record caps)", () => {
  async function storeWith(count: number): Promise<InMemoryEntityStore> {
    const store = new InMemoryEntityStore();
    for (let i = 0; i < count; i += 1) await store.create(TENANT, "Product", { id: `p${i}`, name: `P${i}` });
    return store;
  }
  const created: Handler = () => ({ kind: "json", status: 201, body: { ok: true } });

  it("allows a create under the cap", async () => {
    const store = await storeWith(2);
    const resolver = new InMemoryEntitlementResolver([[TENANT, { status: "active", maxRecordsPerEntity: 5 }]]);
    const out = await withRecordLimit(created, { resolver, store, entity: "Product" })(inputFor(TENANT));
    expect(out.status).toBe(201);
  });

  it("denies a create at the cap with 402 record_limit_reached", async () => {
    const store = await storeWith(5);
    const resolver = new InMemoryEntitlementResolver([[TENANT, { status: "active", maxRecordsPerEntity: 5 }]]);
    const out = await withRecordLimit(created, { resolver, store, entity: "Product" })(inputFor(TENANT));
    expect(out.status).toBe(402);
    const body = (out as Extract<HandlerOutput, { kind: "json" }>).body as Record<string, unknown>;
    expect(body.reason).toBe("record_limit_reached");
    expect(body.entity).toBe("Product");
    expect(body.limit).toBe(5);
  });

  it("ignores the cap when the plan sets none", async () => {
    const store = await storeWith(100);
    const resolver = new InMemoryEntitlementResolver([[TENANT, { status: "active" }]]);
    const out = await withRecordLimit(created, { resolver, store, entity: "Product" })(inputFor(TENANT));
    expect(out.status).toBe(201);
  });

  it("applies the write-status policy before the cap (lapsed → status 402)", async () => {
    const store = await storeWith(0);
    const resolver = new InMemoryEntitlementResolver([[TENANT, { status: "canceled", maxRecordsPerEntity: 5 }]]);
    const out = await withRecordLimit(created, { resolver, store, entity: "Product" })(inputFor(TENANT));
    expect(out.status).toBe(402);
    expect(((out as Extract<HandlerOutput, { kind: "json" }>).body as Record<string, unknown>).reason).toBe("subscription_canceled");
  });

  it("passes an unauthenticated request through", async () => {
    const store = await storeWith(9);
    const resolver = new InMemoryEntitlementResolver([[TENANT, { status: "active", maxRecordsPerEntity: 5 }]]);
    expect((await withRecordLimit(created, { resolver, store, entity: "Product" })(inputFor(null))).status).toBe(201);
  });
});
