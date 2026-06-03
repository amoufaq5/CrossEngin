import type { IncomingRequest } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";

import { buildPrincipalWiring, parseApiKeySpec } from "./principals.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const fakeReq = {} as IncomingRequest;

describe("parseApiKeySpec", () => {
  it("parses key:role:tenant with a default principalId", () => {
    const spec = parseApiKeySpec(`k1:cashier:${TENANT}`);
    expect(spec).toMatchObject({ key: "k1", role: "cashier", tenantId: TENANT });
    expect(spec.principalId).toMatch(/^[0-9a-f-]+$/);
  });

  it("parses an explicit principalId", () => {
    const spec = parseApiKeySpec(`k1:cashier:${TENANT}:00000000-0000-4000-8000-0000000000bb`);
    expect(spec.principalId).toBe("00000000-0000-4000-8000-0000000000bb");
  });

  it("rejects a malformed spec", () => {
    expect(() => parseApiKeySpec("k1:cashier")).toThrow(/invalid --api-key/);
    expect(() => parseApiKeySpec("::")).toThrow(/empty field/);
  });
});

describe("buildPrincipalWiring", () => {
  const wiring = buildPrincipalWiring([parseApiKeySpec(`k1:cashier:${TENANT}`)], {
    now: () => new Date("2026-06-03T12:00:00.000Z"),
  });

  it("looks up a known token to its principal ref + scopes + tenant", async () => {
    const result = await wiring.opaqueTokenLookup.lookup(fakeReq, "k1");
    expect(result).toEqual({ principalRef: "k1", scopes: ["cashier"], tenantId: TENANT });
  });

  it("returns null for an unknown token (fail-closed)", async () => {
    expect(await wiring.opaqueTokenLookup.lookup(fakeReq, "nope")).toBeNull();
  });

  it("resolves the ref to a ResolvedPrincipal", async () => {
    const principal = await wiring.principalResolver.resolve({ principalRef: "k1" } as never);
    expect(principal).toMatchObject({ tenantId: TENANT, grantedScopes: ["cashier"], authScheme: "api_key_header" });
  });

  it("bridges scopes to the primary role", () => {
    expect(wiring.principalRoles({ grantedScopes: ["cashier"] } as never)).toEqual({ primaryRole: "cashier" });
    expect(wiring.principalRoles(null)).toEqual({ primaryRole: "anonymous" });
  });
});
