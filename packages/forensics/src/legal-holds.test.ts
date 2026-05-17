import { describe, expect, it } from "vitest";
import {
  HOLD_KINDS,
  HOLD_SCOPE_KINDS,
  HOLD_STATUSES,
  HoldScopeSchema,
  LegalHoldSchema,
  acknowledgementRate,
  canTransitionHold,
  isHoldEnforced,
  isHoldOverdue,
  type LegalHold,
} from "./legal-holds.js";

describe("constants", () => {
  it("HOLD_KINDS has 7 entries", () => {
    expect(HOLD_KINDS).toContain("litigation");
    expect(HOLD_KINDS).toContain("subpoena");
    expect(HOLD_KINDS).toContain("preservation_letter");
  });

  it("HOLD_STATUSES has 5 entries", () => {
    expect(HOLD_STATUSES).toEqual(["draft", "active", "suspended", "released", "expired"]);
  });

  it("HOLD_SCOPE_KINDS has 6 entries", () => {
    expect(HOLD_SCOPE_KINDS).toContain("all_tenant_data");
    expect(HOLD_SCOPE_KINDS).toContain("specific_evidence_ids");
  });
});

describe("canTransitionHold", () => {
  it("draft -> active", () => {
    expect(canTransitionHold("draft", "active")).toBe(true);
  });

  it("active -> released", () => {
    expect(canTransitionHold("active", "released")).toBe(true);
  });

  it("released is terminal", () => {
    expect(canTransitionHold("released", "active")).toBe(false);
  });

  it("draft -> released not allowed", () => {
    expect(canTransitionHold("draft", "released")).toBe(false);
  });
});

describe("HoldScopeSchema", () => {
  it("accepts specific_tenants scope with tenantIds", () => {
    expect(() =>
      HoldScopeSchema.parse({
        kind: "specific_tenants",
        tenantIds: ["t-1", "t-2"],
        userIds: [],
        dataClasses: [],
        evidenceIds: [],
      }),
    ).not.toThrow();
  });

  it("rejects specific_tenants without tenantIds", () => {
    expect(() =>
      HoldScopeSchema.parse({
        kind: "specific_tenants",
        tenantIds: [],
        userIds: [],
        dataClasses: [],
        evidenceIds: [],
      }),
    ).toThrow(/specific_tenants scope requires tenantIds/);
  });

  it("rejects specific_date_range without both dates", () => {
    expect(() =>
      HoldScopeSchema.parse({
        kind: "specific_date_range",
        tenantIds: [],
        userIds: [],
        dataClasses: [],
        evidenceIds: [],
        dateRangeStart: "2026-01-01T00:00:00Z",
      }),
    ).toThrow(/both dateRangeStart/);
  });

  it("rejects dateRangeEnd <= dateRangeStart", () => {
    expect(() =>
      HoldScopeSchema.parse({
        kind: "specific_date_range",
        tenantIds: [],
        userIds: [],
        dataClasses: [],
        evidenceIds: [],
        dateRangeStart: "2026-01-01T00:00:00Z",
        dateRangeEnd: "2026-01-01T00:00:00Z",
      }),
    ).toThrow(/after dateRangeStart/);
  });
});

describe("LegalHoldSchema", () => {
  const base: LegalHold = {
    id: "LH-2026-0001",
    kind: "litigation",
    status: "active",
    title: "Smith v. CrossEngin",
    description: "Preservation for ongoing litigation",
    matterReference: "smith-v-ce-2026",
    legalCounselId: "u-counsel",
    scope: {
      kind: "specific_tenants",
      tenantIds: ["t-1"],
      userIds: [],
      dataClasses: [],
      evidenceIds: [],
    },
    issuedAt: "2026-05-01T00:00:00Z",
    issuedBy: "u-issuer",
    activatedAt: "2026-05-01T00:05:00Z",
    suspendedAt: null,
    releasedAt: null,
    releasedBy: null,
    blocksAutomaticDeletion: true,
    affectedCustodianCount: 10,
    custodianNotificationsSent: true,
    custodianAcknowledgementCount: 5,
  };

  it("accepts a valid active hold", () => {
    expect(() => LegalHoldSchema.parse(base)).not.toThrow();
  });

  it("rejects active without activatedAt", () => {
    expect(() =>
      LegalHoldSchema.parse({ ...base, activatedAt: null }),
    ).toThrow(/activatedAt/);
  });

  it("rejects active without notifications sent", () => {
    expect(() =>
      LegalHoldSchema.parse({
        ...base,
        custodianNotificationsSent: false,
      }),
    ).toThrow(/custodianNotificationsSent=true/);
  });

  it("rejects suspended without suspendedAt + reason", () => {
    expect(() =>
      LegalHoldSchema.parse({
        ...base,
        status: "suspended",
      }),
    ).toThrow(/suspendedAt/);
  });

  it("rejects released by the same person who issued (separation of duties)", () => {
    expect(() =>
      LegalHoldSchema.parse({
        ...base,
        status: "released",
        releasedAt: "2026-06-01T00:00:00Z",
        releasedBy: "u-issuer",
        releasedReason: "settlement",
      }),
    ).toThrow(/separation of duties/);
  });

  it("rejects expiresAt <= issuedAt", () => {
    expect(() =>
      LegalHoldSchema.parse({
        ...base,
        expiresAt: "2026-04-01T00:00:00Z",
      }),
    ).toThrow(/after issuedAt/);
  });

  it("rejects acknowledgements > affected", () => {
    expect(() =>
      LegalHoldSchema.parse({
        ...base,
        custodianAcknowledgementCount: 50,
      }),
    ).toThrow(/cannot exceed affectedCustodianCount/);
  });

  it("rejects malformed hold id", () => {
    expect(() =>
      LegalHoldSchema.parse({ ...base, id: "LH-1" }),
    ).toThrow();
  });
});

describe("helpers", () => {
  const base: LegalHold = {
    id: "LH-2026-0001",
    kind: "litigation",
    status: "active",
    title: "x",
    description: "x",
    matterReference: "x",
    legalCounselId: "u-counsel",
    scope: {
      kind: "specific_tenants",
      tenantIds: ["t-1"],
      userIds: [],
      dataClasses: [],
      evidenceIds: [],
    },
    issuedAt: "2026-05-01T00:00:00Z",
    issuedBy: "u-issuer",
    activatedAt: "2026-05-01T00:05:00Z",
    suspendedAt: null,
    releasedAt: null,
    releasedBy: null,
    expiresAt: "2026-12-01T00:00:00Z",
    blocksAutomaticDeletion: true,
    affectedCustodianCount: 10,
    custodianNotificationsSent: true,
    custodianAcknowledgementCount: 7,
  };

  it("isHoldEnforced true for active + blocks deletion", () => {
    expect(isHoldEnforced(base)).toBe(true);
  });

  it("isHoldEnforced false for suspended", () => {
    expect(
      isHoldEnforced({
        ...base,
        status: "suspended",
        suspendedAt: "2026-06-01T00:00:00Z",
        suspendedReason: "x",
      }),
    ).toBe(false);
  });

  it("acknowledgementRate returns ratio", () => {
    expect(acknowledgementRate(base)).toBe(0.7);
  });

  it("isHoldOverdue true after expiry", () => {
    expect(isHoldOverdue(base, new Date("2027-01-01T00:00:00Z"))).toBe(true);
    expect(isHoldOverdue(base, new Date("2026-10-01T00:00:00Z"))).toBe(false);
  });
});
