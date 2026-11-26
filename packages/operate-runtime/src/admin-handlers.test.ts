import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { RoleName } from "@crossengin/auth";
import { describe, expect, it } from "vitest";

import { buildAdminSettingsUpdateHandler, type AdminContext } from "./admin-handlers.js";
import { InMemorySettingsStore } from "./settings.js";
import { InMemoryEntityStore } from "./store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function principal(): ResolvedPrincipal {
  return {
    principalId: "00000000-0000-4000-8000-0000000000ab",
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: ["erp_admin"],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-03T12:00:00.000Z",
  };
}

async function put(ctx: AdminContext, body: Record<string, unknown>) {
  const out = await buildAdminSettingsUpdateHandler(ctx)({
    request: {} as never,
    route: {} as never,
    principal: principal(),
    params: {},
    parsedBody: body,
  });
  if (out.kind !== "json") throw new Error("expected json");
  return { status: out.status, body: out.body as Record<string, unknown> };
}

function context(withJurisdictions: boolean) {
  const store = new InMemoryEntityStore();
  const settingsStore = new InMemorySettingsStore();
  const ctx: AdminContext = {
    settingsStore,
    principalRoles: () => ({ primaryRole: "erp_admin" }),
    adminRoles: new Set<RoleName>(["erp_admin" as RoleName]),
    ...(withJurisdictions ? { taxJurisdictions: { store, entity: "TaxJurisdiction" } } : {}),
  };
  return { store, settingsStore, ctx };
}

describe("PUT /v1/admin/settings checks finance.defaultTaxJurisdiction (ADR-0480, ADR-0432 Q5)", () => {
  it("refuses a code no active jurisdiction carries, and saves nothing", async () => {
    const { ctx, settingsStore } = context(true);
    const r = await put(ctx, { finance: { defaultTaxJurisdiction: "XX" } });
    expect([r.status, r.body["error"]]).toEqual([422, "tax_jurisdiction_unresolved"]);
    expect(String(r.body["detail"])).toContain("'XX'");
    expect((await settingsStore.get(TENANT)).finance?.defaultTaxJurisdiction).toBeUndefined();
  });

  it("saves a code one active jurisdiction carries", async () => {
    const { ctx, store, settingsStore } = context(true);
    await store.create(TENANT, "TaxJurisdiction", { code: "UK", name: "UK", country: "GB" });
    const r = await put(ctx, { finance: { defaultTaxJurisdiction: "UK" } });
    expect(r.status).toBe(200);
    expect((await settingsStore.get(TENANT)).finance?.defaultTaxJurisdiction).toBe("UK");
  });

  it("refuses an inactive jurisdiction and an ambiguous code, as the posting would", async () => {
    const inactive = context(true);
    await inactive.store.create(TENANT, "TaxJurisdiction", { code: "UK", name: "UK", country: "GB", is_active: false });
    expect((await put(inactive.ctx, { finance: { defaultTaxJurisdiction: "UK" } })).status).toBe(422);
    const twice = context(true);
    await twice.store.create(TENANT, "TaxJurisdiction", { code: "UK", name: "A", country: "GB" });
    await twice.store.create(TENANT, "TaxJurisdiction", { code: "UK", name: "B", country: "GB" });
    expect((await put(twice.ctx, { finance: { defaultTaxJurisdiction: "UK" } })).status).toBe(422);
  });

  it("saves an unset or blank value, and checks nothing when the manifest declares no jurisdiction", async () => {
    const { ctx } = context(true);
    expect((await put(ctx, { finance: {} })).status).toBe(200);
    expect((await put(ctx, { finance: { defaultTaxJurisdiction: "  " } })).status).toBe(200);
    const none = context(false);
    expect((await put(none.ctx, { finance: { defaultTaxJurisdiction: "XX" } })).status).toBe(200);
  });
});
