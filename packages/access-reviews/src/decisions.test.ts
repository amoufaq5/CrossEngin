import { describe, expect, it } from "vitest";
import {
  ATTESTATION_KINDS,
  AccessReviewDecisionSchema,
  DECISION_KINDS,
  DECISION_REASONS,
  DecisionAttestationSchema,
  STRONG_ATTESTATION_KINDS,
  isStrongAttestation,
  requiresStrongAttestation,
  supersedeDecision,
  type AccessReviewDecision,
} from "./decisions.js";

const baseAttestation = {
  kind: "click_through_acknowledgement" as const,
  attestedAt: "2026-04-15T10:00:00.000Z",
  attestedByUserId: "44444444-4444-4444-4444-444444444444",
  signatureSha256: null,
  signingKeyFingerprint: null,
  coAttestingUserId: null,
  coAttestedAt: null,
  ipAddress: "203.0.113.10",
  userAgent: "Mozilla/5.0",
};

const baseDecision: AccessReviewDecision = {
  id: "ard_abc12345",
  itemId: "ari_abc12345",
  campaignId: "arc_q22026adm",
  tenantId: "11111111-1111-1111-1111-111111111111",
  decidedByUserId: "44444444-4444-4444-4444-444444444444",
  decidedAt: "2026-04-15T10:00:00.000Z",
  kind: "keep",
  reason: "role_appropriate",
  comment: "Reviewer confirms admin role is still required.",
  timeBoundExtendUntil: null,
  modifiedGrantAttributes: null,
  attestation: baseAttestation,
  supersedesDecisionId: null,
  relatedExceptionId: null,
  appliedAt: "2026-04-15T10:05:00.000Z",
  applicationFailedAt: null,
  applicationFailureReason: null,
};

describe("constants", () => {
  it("has 5 decision kinds", () => {
    expect(DECISION_KINDS).toHaveLength(5);
  });
  it("has 14 decision reasons", () => {
    expect(DECISION_REASONS).toHaveLength(14);
  });
  it("has 5 attestation kinds", () => {
    expect(ATTESTATION_KINDS).toHaveLength(5);
  });
  it("e_signature_digital + qualified + two_person are strong", () => {
    expect(STRONG_ATTESTATION_KINDS.has("e_signature_digital")).toBe(true);
    expect(STRONG_ATTESTATION_KINDS.has("qualified_e_signature")).toBe(true);
    expect(STRONG_ATTESTATION_KINDS.has("two_person_attestation")).toBe(true);
    expect(STRONG_ATTESTATION_KINDS.has("click_through_acknowledgement")).toBe(false);
  });
});

describe("DecisionAttestationSchema", () => {
  it("accepts a click-through attestation", () => {
    expect(() => DecisionAttestationSchema.parse(baseAttestation)).not.toThrow();
  });

  it("requires signatureSha256 for e_signature_digital", () => {
    expect(() =>
      DecisionAttestationSchema.parse({
        ...baseAttestation,
        kind: "e_signature_digital",
      }),
    ).toThrow(/requires signatureSha256/);
  });

  it("requires co-attestor for two_person_attestation", () => {
    expect(() =>
      DecisionAttestationSchema.parse({
        ...baseAttestation,
        kind: "two_person_attestation",
      }),
    ).toThrow(/requires coAttestingUserId/);
  });

  it("rejects co-attestor same as primary attestor", () => {
    expect(() =>
      DecisionAttestationSchema.parse({
        ...baseAttestation,
        kind: "two_person_attestation",
        coAttestingUserId: baseAttestation.attestedByUserId,
        coAttestedAt: "2026-04-15T10:01:00.000Z",
      }),
    ).toThrow(/co-attestor must differ/);
  });
});

describe("AccessReviewDecisionSchema", () => {
  it("accepts a valid keep decision", () => {
    expect(() => AccessReviewDecisionSchema.parse(baseDecision)).not.toThrow();
  });

  it("rejects decidedByUserId != attestation.attestedByUserId", () => {
    expect(() =>
      AccessReviewDecisionSchema.parse({
        ...baseDecision,
        decidedByUserId: "99999999-9999-9999-9999-999999999999",
      }),
    ).toThrow(/decidedByUserId must match/);
  });

  it("rejects time_bound_extend without timeBoundExtendUntil", () => {
    expect(() =>
      AccessReviewDecisionSchema.parse({
        ...baseDecision,
        kind: "time_bound_extend",
      }),
    ).toThrow(/time_bound_extend decision requires timeBoundExtendUntil/);
  });

  it("rejects modify_grant without modifiedGrantAttributes", () => {
    expect(() =>
      AccessReviewDecisionSchema.parse({
        ...baseDecision,
        kind: "modify_grant",
        reason: "role_changed_modified",
      }),
    ).toThrow(/modify_grant decision requires modifiedGrantAttributes/);
  });

  it("rejects keep + security_concern_revoked reason (inconsistent)", () => {
    expect(() =>
      AccessReviewDecisionSchema.parse({
        ...baseDecision,
        kind: "keep",
        reason: "security_concern_revoked",
      }),
    ).toThrow(/inconsistent/);
  });

  it("rejects revoke + role_appropriate reason (inconsistent)", () => {
    expect(() =>
      AccessReviewDecisionSchema.parse({
        ...baseDecision,
        kind: "revoke",
        reason: "role_appropriate",
      }),
    ).toThrow(/inconsistent/);
  });

  it("rejects timeBoundExtendUntil <= decidedAt", () => {
    expect(() =>
      AccessReviewDecisionSchema.parse({
        ...baseDecision,
        kind: "time_bound_extend",
        timeBoundExtendUntil: baseDecision.decidedAt,
      }),
    ).toThrow(/timeBoundExtendUntil must be after decidedAt/);
  });

  it("rejects appliedAt before decidedAt", () => {
    expect(() =>
      AccessReviewDecisionSchema.parse({
        ...baseDecision,
        appliedAt: "2026-04-10T00:00:00.000Z",
      }),
    ).toThrow(/cannot precede decidedAt/);
  });

  it("rejects applicationFailedAt without applicationFailureReason", () => {
    expect(() =>
      AccessReviewDecisionSchema.parse({
        ...baseDecision,
        applicationFailedAt: "2026-04-15T11:00:00.000Z",
      }),
    ).toThrow(/requires applicationFailureReason/);
  });
});

describe("isStrongAttestation", () => {
  it("returns true for e_signature_digital", () => {
    expect(
      isStrongAttestation({
        ...baseAttestation,
        kind: "e_signature_digital",
        signatureSha256: "a".repeat(64),
        signingKeyFingerprint: "b".repeat(64),
      }),
    ).toBe(true);
  });
  it("returns false for click_through", () => {
    expect(isStrongAttestation(baseAttestation)).toBe(false);
  });
});

describe("requiresStrongAttestation", () => {
  it("regulatory_requirement requires strong", () => {
    expect(requiresStrongAttestation("keep", "regulatory_requirement")).toBe(true);
  });
  it("time_bound_extend requires strong", () => {
    expect(requiresStrongAttestation("time_bound_extend", "manager_attestation")).toBe(true);
  });
  it("security_concern_revoked requires strong", () => {
    expect(requiresStrongAttestation("revoke", "security_concern_revoked")).toBe(true);
  });
  it("routine keep + role_appropriate does not require strong", () => {
    expect(requiresStrongAttestation("keep", "role_appropriate")).toBe(false);
  });
});

describe("supersedeDecision", () => {
  it("links supersedesDecisionId to prior", () => {
    const next = supersedeDecision(baseDecision, {
      ...baseDecision,
      id: "ard_xyz77890",
      kind: "revoke",
      reason: "departure_revoked",
      appliedAt: null,
      comment: "Departure attested.",
    });
    expect(next.supersedesDecisionId).toBe(baseDecision.id);
  });
});
