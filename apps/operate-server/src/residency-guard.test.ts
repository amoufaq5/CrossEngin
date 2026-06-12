import { describe, expect, it } from "vitest";

import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import { ResidencyGuard, parseRegion, parseTenantResidencySpec } from "./residency-guard.js";
import type { OperateDispatcher } from "./tenant-dispatcher.js";

const T_EU = "00000000-0000-4000-8000-0000000000e1";
const T_US = "00000000-0000-4000-8000-0000000000a1";

function req(tenantKey: string): RawHttpRequest {
  return { method: "GET", url: "/v1/products", headers: { "x-api-key": tenantKey, host: "h" }, remoteAddress: "1.1.1.1" };
}

/** An inner dispatcher that records whether it was reached + returns a 200. */
function passthrough(): { inner: OperateDispatcher; reached: () => boolean } {
  let hit = false;
  return {
    reached: () => hit,
    inner: {
      async dispatchWithMatch(): Promise<{ response: RawHttpResponse; matchedOperationId: string | null }> {
        hit = true;
        return { response: { status: 200, headers: {}, body: null }, matchedOperationId: "product.list" };
      },
    },
  };
}

// keys map straight to tenants for the test
const tenantOf = (raw: RawHttpRequest): string | null => {
  const k = raw.headers["x-api-key"];
  return typeof k === "string" && k.length > 0 ? k : null;
};

const EU_PROFILE = parseTenantResidencySpec(`${T_EU}:eu-only`).profile; // allowed eu-central/eu-west
const PROFILES = new Map([[T_EU, EU_PROFILE]]);

describe("parseTenantResidencySpec / parseRegion", () => {
  it("parses a tenantId:template spec into a bound profile", () => {
    const spec = parseTenantResidencySpec(`${T_EU}:eu-only`);
    expect(spec.tenantId).toBe(T_EU);
    expect(spec.profile.allowedRegions).toContain("eu-central");
  });

  it("rejects an unknown template / malformed spec", () => {
    expect(() => parseTenantResidencySpec(`${T_EU}:mars-only`)).toThrow(/invalid residency template/);
    expect(() => parseTenantResidencySpec("no-colon")).toThrow();
  });

  it("validates a region", () => {
    expect(parseRegion("eu-central")).toBe("eu-central");
    expect(() => parseRegion("atlantis")).toThrow(/invalid --region/);
  });
});

describe("ResidencyGuard", () => {
  it("421s a residency-bound tenant served from a forbidden region, naming the primary", async () => {
    const { inner, reached } = passthrough();
    const guard = new ResidencyGuard({ region: "us-east", inner, tenantOf, profiles: PROFILES });
    const { response } = await guard.dispatchWithMatch(req(T_EU), null);
    expect(response.status).toBe(421);
    expect(response.headers["x-crossengin-required-region"]).toBe("eu-central");
    const body = JSON.parse(new TextDecoder().decode(response.body!)) as { extensions: { requiredRegion: string; servedRegion: string } };
    expect(body.extensions).toMatchObject({ requiredRegion: "eu-central", servedRegion: "us-east" });
    expect(reached()).toBe(false); // never reached the gateway
  });

  it("passes through when this instance's region is residency-allowed", async () => {
    const { inner, reached } = passthrough();
    const guard = new ResidencyGuard({ region: "eu-west", inner, tenantOf, profiles: PROFILES });
    expect((await guard.dispatchWithMatch(req(T_EU), null)).response.status).toBe(200);
    expect(reached()).toBe(true);
  });

  it("passes through a tenant with no residency binding", async () => {
    const { inner, reached } = passthrough();
    const guard = new ResidencyGuard({ region: "us-east", inner, tenantOf, profiles: PROFILES });
    expect((await guard.dispatchWithMatch(req(T_US), null)).response.status).toBe(200);
    expect(reached()).toBe(true);
  });

  it("passes through when the tenant can't be pre-resolved", async () => {
    const { inner, reached } = passthrough();
    const guard = new ResidencyGuard({ region: "us-east", inner, tenantOf: () => null, profiles: PROFILES });
    await guard.dispatchWithMatch(req(T_EU), null);
    expect(reached()).toBe(true);
  });
});
