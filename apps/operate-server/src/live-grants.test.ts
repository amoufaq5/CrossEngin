import { describe, expect, it } from "vitest";
import type { Principal } from "@crossengin/auth";
import type { AccessReviewCampaign } from "@crossengin/access-reviews";

import { parseApiKeySpec } from "./principals.js";
import {
  AuthLiveGrantSource,
  StaticLiveGrantSource,
  apiKeyPrincipalProvider,
  principalToLiveGrants,
  principalsToLiveGrants,
} from "./live-grants.js";

const TENANT = "11111111-1111-1111-1111-111111111111";

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    kind: "user",
    tenantId: TENANT as Principal["tenantId"],
    userId: "22222222-2222-2222-2222-222222222222" as Principal["userId"],
    primaryRole: "store_manager",
    secondaryRoles: [],
    abacAttributes: {},
    mfaProofAgeSeconds: null,
    ...overrides,
  };
}

const campaign = { tenantId: TENANT } as AccessReviewCampaign;

describe("principalToLiveGrants", () => {
  it("maps a principal to a review subject + one role-grant per role", () => {
    const snap = principalToLiveGrants(
      principal({ primaryRole: "store_manager", secondaryRoles: ["cashier", "store_manager"] }),
    );
    expect(snap.principals).toHaveLength(1);
    const subject = snap.principals[0]!;
    expect(subject.principalId).toBe("22222222-2222-2222-2222-222222222222");
    expect(subject.principalType).toBe("user");
    expect(subject.mfaStatus).toBe("none");
    // primary + secondary, de-duplicated (store_manager appears once).
    expect(snap.grants.map((g) => g.resourceLabel).sort()).toEqual(["cashier", "store_manager"]);
    for (const grant of snap.grants) {
      expect(grant.kind).toBe("role");
      expect(grant.principalId).toBe(subject.principalId);
      expect(grant.grantId).toContain(":");
    }
  });

  it("marks mfa strong when a proof age is present", () => {
    const snap = principalToLiveGrants(principal({ mfaProofAgeSeconds: 120 }));
    expect(snap.principals[0]?.mfaStatus).toBe("any_strong");
  });

  it("yields nothing for a principal with no userId", () => {
    const snap = principalToLiveGrants(principal({ userId: null, kind: "system" }));
    expect(snap.grants).toEqual([]);
    expect(snap.principals).toEqual([]);
  });

  it("honours a grantedAt + displayLabel override", () => {
    const snap = principalToLiveGrants(principal(), {
      grantedAt: "2026-01-01T00:00:00.000Z",
      displayLabel: (p) => `label:${p.primaryRole}`,
    });
    expect(snap.principals[0]?.displayLabel).toBe("label:store_manager");
    expect(snap.grants[0]?.grantedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("principalsToLiveGrants", () => {
  it("flattens many principals into one snapshot", () => {
    const snap = principalsToLiveGrants([
      principal({ userId: "33333333-3333-3333-3333-333333333333" as Principal["userId"] }),
      principal({ userId: "44444444-4444-4444-4444-444444444444" as Principal["userId"], primaryRole: "cashier" }),
    ]);
    expect(snap.principals).toHaveLength(2);
    expect(snap.grants).toHaveLength(2);
  });
});

describe("apiKeyPrincipalProvider", () => {
  it("maps the server's API-key specs to per-tenant principals with stable uuids", async () => {
    const provider = apiKeyPrincipalProvider([
      parseApiKeySpec(`key-mgr:store_manager:${TENANT}`),
      parseApiKeySpec(`key-cashier:cashier:${TENANT}`),
      parseApiKeySpec("key-other:cashier:99999999-9999-9999-9999-999999999999"),
    ]);
    const forTenant = await provider.listPrincipals(TENANT);
    expect(forTenant).toHaveLength(2);
    expect(forTenant.every((p) => p.tenantId === TENANT)).toBe(true);
    // Distinct keys ⇒ distinct (valid uuid) principal ids.
    const ids = new Set(forTenant.map((p) => p.userId));
    expect(ids.size).toBe(2);
    for (const p of forTenant) {
      expect(p.userId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("returns [] for a tenant with no keys", async () => {
    const provider = apiKeyPrincipalProvider([]);
    expect(await provider.listPrincipals(TENANT)).toEqual([]);
  });
});

describe("AuthLiveGrantSource", () => {
  it("resolves the campaign tenant's principals into a grant snapshot", async () => {
    const source = new AuthLiveGrantSource(
      apiKeyPrincipalProvider([parseApiKeySpec(`key-mgr:store_manager:${TENANT}`)]),
    );
    const snap = await source.grantsForCampaign(campaign);
    expect(snap.principals).toHaveLength(1);
    expect(snap.grants).toHaveLength(1);
    expect(snap.grants[0]?.resourceLabel).toBe("store_manager");
  });
});

describe("StaticLiveGrantSource", () => {
  it("returns its fixed snapshot regardless of campaign", async () => {
    const source = new StaticLiveGrantSource({ grants: [], principals: [] });
    expect(await source.grantsForCampaign()).toEqual({ grants: [], principals: [] });
  });
});
