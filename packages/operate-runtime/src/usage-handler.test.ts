import type { HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import { describe, expect, it } from "vitest";

import { InMemoryEntitlementResolver } from "./entitlement.js";
import { InMemoryEntityStore } from "./store.js";
import { buildUsageHandler, type EntityUsage, type UsageView } from "./usage-handler.js";

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

function viewOf(out: HandlerOutput): UsageView {
  return (out as Extract<HandlerOutput, { kind: "json" }>).body as UsageView;
}

function usageFor(view: UsageView, entity: string): EntityUsage {
  const u = view.entities.find((e) => e.entity === entity);
  if (u === undefined) throw new Error(`no usage for ${entity}`);
  return u;
}

async function seed(store: InMemoryEntityStore, entity: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await store.create(TENANT, entity, { id: `${entity}-${i}`, name: `row ${i}` });
  }
}

describe("buildUsageHandler", () => {
  it("reports per-entity counts against the plan cap", async () => {
    const store = new InMemoryEntityStore();
    await seed(store, "Product", 3);
    await seed(store, "Store", 1);
    const resolver = new InMemoryEntitlementResolver([[TENANT, { status: "active", planId: "pro", maxRecordsPerEntity: 10 }]]);
    const out = await buildUsageHandler({ resolver, store, entities: ["Product", "Store"] })(inputFor(TENANT));
    expect(out.status).toBe(200);
    const view = viewOf(out);
    expect(view.maxRecordsPerEntity).toBe(10);
    expect(usageFor(view, "Product")).toEqual({ entity: "Product", used: 3, overflow: false, atLimit: false });
    expect(usageFor(view, "Store")).toEqual({ entity: "Store", used: 1, overflow: false, atLimit: false });
  });

  it("flags an entity that is over its cap (probe reads cap+1)", async () => {
    const store = new InMemoryEntityStore();
    await seed(store, "Product", 6); // one past the cap of 5
    const resolver = new InMemoryEntitlementResolver([[TENANT, { status: "active", maxRecordsPerEntity: 5 }]]);
    const out = await buildUsageHandler({ resolver, store, entities: ["Product"] })(inputFor(TENANT));
    const u = usageFor(viewOf(out), "Product");
    // capped probe reads cap+1=6; used is bounded at the cap, atLimit + overflow true.
    expect(u.atLimit).toBe(true);
    expect(u.used).toBe(5);
    expect(u.overflow).toBe(true);
  });

  it("reports exactly-at-cap as atLimit without overflow", async () => {
    const store = new InMemoryEntityStore();
    await seed(store, "Product", 5);
    const resolver = new InMemoryEntitlementResolver([[TENANT, { status: "active", maxRecordsPerEntity: 5 }]]);
    const out = await buildUsageHandler({ resolver, store, entities: ["Product"] })(inputFor(TENANT));
    const u = usageFor(viewOf(out), "Product");
    expect(u).toEqual({ entity: "Product", used: 5, overflow: false, atLimit: true });
  });

  it("counts up to a display ceiling when the plan is unlimited", async () => {
    const store = new InMemoryEntityStore();
    await seed(store, "Product", 4);
    const resolver = new InMemoryEntitlementResolver([[TENANT, { status: "active" }]]);
    const out = await buildUsageHandler({ resolver, store, entities: ["Product"], displayCeiling: 2 })(inputFor(TENANT));
    const view = viewOf(out);
    expect(view.maxRecordsPerEntity).toBeNull();
    const u = usageFor(view, "Product");
    expect(u.used).toBe(2); // bounded at the display ceiling
    expect(u.overflow).toBe(true);
    expect(u.atLimit).toBe(false); // no cap to breach
  });

  it("reports a null cap + no records for a tenant with no subscription", async () => {
    const store = new InMemoryEntityStore();
    const resolver = new InMemoryEntitlementResolver();
    const out = await buildUsageHandler({ resolver, store, entities: ["Product"] })(inputFor(TENANT));
    const view = viewOf(out);
    expect(view.maxRecordsPerEntity).toBeNull();
    expect(usageFor(view, "Product")).toEqual({ entity: "Product", used: 0, overflow: false, atLimit: false });
  });

  it("returns 401 tenant_required when the principal has no tenant", async () => {
    const store = new InMemoryEntityStore();
    const resolver = new InMemoryEntitlementResolver();
    const out = await buildUsageHandler({ resolver, store, entities: ["Product"] })(inputFor(null));
    expect(out.status).toBe(401);
  });
});
