import { describe, expect, it } from "vitest";
import {
  CampaignScopeSchema,
  GRANT_KINDS,
  PRINCIPAL_TYPES,
  PrincipalUnderReviewSchema,
  ReviewGrantSchema,
  SCOPE_KINDS,
  isHighRiskPrincipal,
  principalMatchesScope,
  type PrincipalUnderReview,
} from "./scope.js";

const basePrincipal: PrincipalUnderReview = {
  principalId: "11111111-1111-1111-1111-111111111111",
  principalType: "user",
  displayLabel: "alice@acme.com",
  tenantId: "22222222-2222-2222-2222-222222222222",
  isExternal: false,
  managerUserId: "33333333-3333-3333-3333-333333333333",
  mfaStatus: "webauthn",
  lastLoginAt: "2026-05-15T10:00:00.000Z",
};

describe("constants", () => {
  it("has 8 scope kinds", () => {
    expect(SCOPE_KINDS).toHaveLength(8);
  });
  it("has 5 principal types", () => {
    expect(PRINCIPAL_TYPES).toHaveLength(5);
  });
  it("has 7 grant kinds", () => {
    expect(GRANT_KINDS).toHaveLength(7);
  });
});

describe("CampaignScopeSchema", () => {
  it("accepts all_users_with_role", () => {
    expect(() =>
      CampaignScopeSchema.parse({
        kind: "all_users_with_role",
        roleSlug: "admin",
        includeInherited: true,
      }),
    ).not.toThrow();
  });

  it("rejects all_users_with_role with uppercase roleSlug", () => {
    expect(() =>
      CampaignScopeSchema.parse({
        kind: "all_users_with_role",
        roleSlug: "Admin",
      }),
    ).toThrow();
  });

  it("accepts specific_principals", () => {
    expect(() =>
      CampaignScopeSchema.parse({
        kind: "specific_principals",
        principalIds: ["11111111-1111-1111-1111-111111111111"],
      }),
    ).not.toThrow();
  });

  it("rejects specific_principals with empty list", () => {
    expect(() =>
      CampaignScopeSchema.parse({
        kind: "specific_principals",
        principalIds: [],
      }),
    ).toThrow();
  });

  it("accepts last_login_older_than", () => {
    expect(() =>
      CampaignScopeSchema.parse({
        kind: "last_login_older_than",
        thresholdDays: 90,
      }),
    ).not.toThrow();
  });

  it("accepts mfa_status_in with multiple statuses", () => {
    expect(() =>
      CampaignScopeSchema.parse({
        kind: "mfa_status_in",
        statuses: ["none", "weak_only_sms"],
      }),
    ).not.toThrow();
  });
});

describe("PrincipalUnderReviewSchema", () => {
  it("accepts a valid principal", () => {
    expect(() => PrincipalUnderReviewSchema.parse(basePrincipal)).not.toThrow();
  });
});

describe("ReviewGrantSchema", () => {
  it("accepts a role grant", () => {
    expect(() =>
      ReviewGrantSchema.parse({
        kind: "role",
        grantId: "role:admin",
        resourceLabel: "Admin role",
        attributes: {},
        grantedAt: "2026-01-15T10:00:00.000Z",
        grantedBy: "44444444-4444-4444-4444-444444444444",
        lastUsedAt: null,
      }),
    ).not.toThrow();
  });
});

describe("principalMatchesScope", () => {
  const now = new Date("2026-05-16T10:00:00Z");

  it("all_users_with_role matches users", () => {
    expect(
      principalMatchesScope(
        { kind: "all_users_with_role", roleSlug: "admin", includeInherited: true },
        basePrincipal,
        now,
      ),
    ).toBe(true);
  });

  it("all_users_with_role does not match service accounts", () => {
    expect(
      principalMatchesScope(
        { kind: "all_users_with_role", roleSlug: "admin", includeInherited: true },
        { ...basePrincipal, principalType: "service_account" },
        now,
      ),
    ).toBe(false);
  });

  it("specific_principals matches when id is in list", () => {
    expect(
      principalMatchesScope(
        {
          kind: "specific_principals",
          principalIds: [basePrincipal.principalId],
        },
        basePrincipal,
        now,
      ),
    ).toBe(true);
  });

  it("mfa_status_in matches when status is in list", () => {
    expect(
      principalMatchesScope(
        { kind: "mfa_status_in", statuses: ["webauthn", "any_strong"] },
        basePrincipal,
        now,
      ),
    ).toBe(true);
  });

  it("last_login_older_than matches stale logins", () => {
    expect(
      principalMatchesScope(
        { kind: "last_login_older_than", thresholdDays: 30 },
        {
          ...basePrincipal,
          lastLoginAt: "2026-01-01T00:00:00.000Z",
        },
        now,
      ),
    ).toBe(true);
  });

  it("last_login_older_than matches null lastLoginAt (never logged in)", () => {
    expect(
      principalMatchesScope(
        { kind: "last_login_older_than", thresholdDays: 30 },
        { ...basePrincipal, lastLoginAt: null },
        now,
      ),
    ).toBe(true);
  });

  it("service_accounts_only matches service_account principal", () => {
    expect(
      principalMatchesScope(
        { kind: "service_accounts_only", includeSystemAccounts: false },
        { ...basePrincipal, principalType: "service_account" },
        now,
      ),
    ).toBe(true);
  });

  it("service_accounts_only with includeSystemAccounts matches system too", () => {
    expect(
      principalMatchesScope(
        { kind: "service_accounts_only", includeSystemAccounts: true },
        { ...basePrincipal, principalType: "system" },
        now,
      ),
    ).toBe(true);
  });
});

describe("isHighRiskPrincipal", () => {
  const now = new Date("2026-05-16T10:00:00Z");

  it("flags no-MFA as high risk", () => {
    expect(isHighRiskPrincipal({ ...basePrincipal, mfaStatus: "none" }, now)).toBe(true);
  });

  it("flags weak SMS-only MFA as high risk", () => {
    expect(isHighRiskPrincipal({ ...basePrincipal, mfaStatus: "weak_only_sms" }, now)).toBe(true);
  });

  it("flags no recent login as high risk", () => {
    expect(isHighRiskPrincipal({ ...basePrincipal, lastLoginAt: null }, now)).toBe(true);
  });

  it("flags stale login as high risk", () => {
    expect(
      isHighRiskPrincipal({ ...basePrincipal, lastLoginAt: "2026-01-01T00:00:00.000Z" }, now),
    ).toBe(true);
  });

  it("does not flag strong MFA + recent login", () => {
    expect(isHighRiskPrincipal(basePrincipal, now)).toBe(false);
  });
});
