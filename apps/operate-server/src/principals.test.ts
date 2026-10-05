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

  it("records whether the principal was named, rather than leaving it to be guessed", () => {
    // Not derivable by comparing against the placeholder: a spec may name that very UUID, and then
    // it means a real provisioned user who holds it.
    expect(parseApiKeySpec(`k1:cashier:${TENANT}`).namesPrincipal).toBe(false);
    expect(parseApiKeySpec(`k1:cashier:${TENANT}:00000000-0000-4000-8000-0000000000bb`).namesPrincipal).toBe(true);
    expect(parseApiKeySpec(`k1:cashier:${TENANT}:00000000-0000-4000-8000-0000000000aa`).namesPrincipal).toBe(true);
  });

  it("shares one principal id across every unnamed key, which is why the kind must say so", () => {
    // The collision is not fixable in the spec — a bare `key:role:tenant` does not carry the
    // information to tell two keys apart, and the one thing that would is the credential itself,
    // which must not be hashed into an id that lands in the audit log.
    const a = parseApiKeySpec(`k1:cashier:${TENANT}`);
    const b = parseApiKeySpec(`k2:manager:${TENANT}`);
    expect(a.principalId).toBe(b.principalId);
    expect([a.namesPrincipal, b.namesPrincipal]).toEqual([false, false]);
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

  it("resolves an unnamed key as a service account, not as a user", async () => {
    // One line, three defects downstream. As `user` it satisfied every per-person surface's guard,
    // and the placeholder is not in `meta.users`: `notification_read_states.user_id` failed its
    // foreign key (reported as a 503 for something permanent) and `actorForInstanceCancel` would
    // have handed the id to `cancelled_by_user_id`, which has the same key. And since the id is
    // shared, two keys in one tenant would have shared read state.
    const principal = await wiring.principalResolver.resolve({ principalRef: "k1" } as never);
    expect(principal?.principalKind).toBe("service_account");
  });

  it("still resolves a key that names its principal as a user", async () => {
    const named = buildPrincipalWiring(
      [parseApiKeySpec(`k9:cashier:${TENANT}:00000000-0000-4000-8000-0000000000bb`)],
      { now: () => new Date("2026-06-03T12:00:00.000Z") },
    );
    const principal = await named.principalResolver.resolve({ principalRef: "k9" } as never);
    expect(principal).toMatchObject({
      principalKind: "user",
      principalId: "00000000-0000-4000-8000-0000000000bb",
    });
  });
});
