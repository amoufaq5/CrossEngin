import type { Handler, HandlerInput } from "@crossengin/api-gateway-runtime";
import { HandlerRegistry, residencyRefusal } from "@crossengin/api-gateway-runtime";
import { buildProfileFromTemplate } from "@crossengin/residency";
import { InMemoryTenantResidencyDirectory } from "@crossengin/residency-runtime";
import { describe, expect, it } from "vitest";

import {
  applyResidencyGate,
  formatResidencyGate,
  withResidency,
  type ResidencyGateRefusal,
} from "./residency-gate.js";

const EU = "00000000-0000-4000-8000-0000000000e1";
const NONE = "00000000-0000-4000-8000-0000000000e2";
const euOnly = buildProfileFromTemplate("eu-only", { establishedAt: "2026-01-01T00:00:00.000Z" });

function input(tenantId: string | null): HandlerInput {
  return {
    principal: tenantId === null ? null : { tenantId },
    route: { method: "GET" },
  } as unknown as HandlerInput;
}

function counting(): Handler & { calls: number } {
  const h = Object.assign(
    async () => {
      h.calls += 1;
      return { kind: "json" as const, status: 200, body: { ok: true } };
    },
    { calls: 0 },
  );
  return h;
}

const directory = new InMemoryTenantResidencyDirectory([[EU, euOnly]]);

describe("residency-gate — the decision on the authenticated tenant", () => {
  it("serves a tenant whose profile allows this region", async () => {
    const inner = counting();
    const out = await withResidency(inner, "products.list", { region: "eu-central", directory })(input(EU));
    expect(out.status).toBe(200);
    expect(inner.calls).toBe(1);
  });

  // A job's write resolves the very handler this gate wraps (`buildSystemEntityAccess` dispatches
  // through the compiled registry), and the job queue is claimed by any instance's worker. Gating it
  // would fail a profiled tenant's jobs on every instance outside its home region.
  it("serves a job's system principal even where the tenant's profile forbids this region", async () => {
    const inner = counting();
    const refusals: ResidencyGateRefusal[] = [];
    const system = {
      principal: { tenantId: EU, principalKind: "system" },
      route: { method: "POST" },
    } as unknown as HandlerInput;
    const out = await withResidency(inner, "invoices.create", {
      region: "us-east",
      directory,
      onRefused: (r) => refusals.push(r),
    })(system);
    expect(out.status).toBe(200);
    expect(inner.calls).toBe(1);
    expect(refusals).toEqual([]);
    // The control: the same tenant over a request-borne principal is refused.
    const user = {
      principal: { tenantId: EU, principalKind: "user" },
      route: { method: "POST" },
    } as unknown as HandlerInput;
    expect((await withResidency(inner, "invoices.create", { region: "us-east", directory })(user)).status).toBe(421);
  });

  it("refuses 421 naming the home region, without calling the handler", async () => {
    const inner = counting();
    const refusals: ResidencyGateRefusal[] = [];
    const out = await withResidency(inner, "products.list", {
      region: "us-east",
      directory,
      onRefused: (r) => refusals.push(r),
    })(input(EU));
    expect(out.status).toBe(421);
    expect(out.headers?.["x-crossengin-region"]).toBe("eu-central");
    // ADR-0457: the registry's type and both carriers of the home region, the shape the pre-auth
    // hint check answers too, from the one builder.
    if (out.kind !== "json") throw new Error("expected a json refusal");
    const body = out.body as { detail: string; type: string; extensions: unknown };
    expect(body.type).toBe("https://crossengin.io/errors/residency-misdirected");
    expect(body.extensions).toEqual({ reason: "residency_misdirected", correctRegion: "eu-central" });
    expect(body).toEqual(
      residencyRefusal({ decision: "misdirected", detail: body.detail, correctRegion: "eu-central" }).body,
    );
    expect(inner.calls).toBe(0);
    expect(refusals).toEqual([
      { decision: "misdirected", operationId: "products.list", tenantId: EU, region: "us-east" },
    ]);
  });

  it("refuses 403 when the profile allows no region it can name", async () => {
    const inner = counting();
    // The home region itself is outside the allowed set, so there is nowhere to redirect to.
    const profile = { ...euOnly, allowedRegions: euOnly.allowedRegions.filter((r) => r !== euOnly.primaryRegion) };
    const strict = new InMemoryTenantResidencyDirectory([[EU, profile]]);
    const out = await withResidency(inner, "products.list", { region: "us-east", directory: strict })(input(EU));
    expect(out.status).toBe(403);
    expect(out.headers?.["x-crossengin-region"]).toBeUndefined();
    expect(inner.calls).toBe(0);
  });

  it("fails closed with a retryable 503 when the directory throws", async () => {
    const inner = counting();
    const out = await withResidency(inner, "products.list", {
      region: "eu-central",
      directory: {
        resolve: async () => {
          throw new Error("down");
        },
      },
    })(input(EU));
    expect(out.status).toBe(503);
    expect(out.headers?.["retry-after"]).toBeDefined();
    expect(inner.calls).toBe(0);
  });

  it("serves a tenant with no profile, which is the stated choice for an unprofiled tenant", async () => {
    const inner = counting();
    const out = await withResidency(inner, "products.list", { region: "us-east", directory })(input(NONE));
    expect(out.status).toBe(200);
    expect(inner.calls).toBe(1);
  });

  it("does not consult the directory for a request with no authenticated tenant", async () => {
    let asked = 0;
    const inner = counting();
    await withResidency(inner, "products.list", {
      region: "us-east",
      directory: {
        resolve: () => {
          asked += 1;
          return euOnly;
        },
      },
    })(input(null));
    expect(asked).toBe(0);
    expect(inner.calls).toBe(1);
  });

  it("exempts platform routes and wraps every other registered handler", async () => {
    const registry = new HandlerRegistry();
    const platform = counting();
    registry.register("platform.tenants.list", platform);
    registry.register("products.list", counting());
    registry.register("products.read", counting());
    const wrapped = applyResidencyGate(registry, { region: "us-east", directory });
    expect(wrapped).toBe(2);
    expect(registry.resolve("platform.tenants.list")).toBe(platform);
    expect((await registry.resolve("products.read")!(input(EU))).status).toBe(421);
  });

  it("says at boot that it decides the instance and not where the rows live", () => {
    const line = formatResidencyGate("eu-central");
    expect(line).toContain("background job");
    expect(line).toContain("authenticated tenant");
    expect(line).toContain("no profile is served");
    expect(line).toContain("infrastructure");
  });
});
