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

const CO_ATTESTOR = "55555555-5555-5555-5555-555555555555";

const twoPerson = (coAttestedAt: string) => ({
  ...baseAttestation,
  kind: "two_person_attestation" as const,
  coAttestingUserId: CO_ATTESTOR,
  coAttestedAt,
});

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
    expect(STRONG_ATTESTATION_KINDS.has("click_through_acknowledgement")).toBe(
      false,
    );
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

  it("accepts a two_person_attestation whose co-attestation follows the primary one", () => {
    expect(() =>
      DecisionAttestationSchema.parse(twoPerson("2026-04-15T10:05:00.000Z")),
    ).not.toThrow();
  });

  it("accepts a co-attestation at the same instant as the primary one", () => {
    expect(() =>
      DecisionAttestationSchema.parse(twoPerson(baseAttestation.attestedAt)),
    ).not.toThrow();
  });

  it("orders the pair as instants, not as strings", () => {
    // The same instant as baseAttestation.attestedAt, rendered at -02:00 so that it sorts
    // lexicographically *before* it ("08" < "10"). A string comparison would refuse this.
    const sameInstantEarlierSpelling = "2026-04-15T08:00:00.000-02:00";
    expect(Date.parse(sameInstantEarlierSpelling)).toBe(
      Date.parse(baseAttestation.attestedAt),
    );
    expect(
      sameInstantEarlierSpelling < baseAttestation.attestedAt,
    ).toBe(true);
    expect(() =>
      DecisionAttestationSchema.parse(twoPerson(sameInstantEarlierSpelling)),
    ).not.toThrow();
  });

  it("accepts a null coAttestedAt", () => {
    expect(baseAttestation.coAttestedAt).toBeNull();
    expect(() => DecisionAttestationSchema.parse(baseAttestation)).not.toThrow();
  });

  it("rejects coAttestedAt before attestedAt", () => {
    expect(() =>
      DecisionAttestationSchema.parse(twoPerson("2026-04-14T23:59:59.000Z")),
    ).toThrow(/coAttestedAt cannot precede attestedAt/);
  });

  it("orders any present coAttestedAt, not only a two_person one", () => {
    // Guarded on the value rather than the kind: a backdated co-attestation is incoherent
    // whichever kind carries it, and only this clause should fire for a click-through.
    expect(() =>
      DecisionAttestationSchema.parse({
        ...baseAttestation,
        coAttestedAt: "2026-04-14T23:59:59.000Z",
      }),
    ).toThrow(/coAttestedAt cannot precede attestedAt/);
  });

  it("accepts typed_attestation_phrase carrying a phrase", () => {
    expect(() =>
      DecisionAttestationSchema.parse({
        ...baseAttestation,
        kind: "typed_attestation_phrase",
        attestationPhrase: "I attest this access is still required.",
      }),
    ).not.toThrow();
  });

  it("rejects typed_attestation_phrase with no phrase", () => {
    expect(() =>
      DecisionAttestationSchema.parse({
        ...baseAttestation,
        kind: "typed_attestation_phrase",
      }),
    ).toThrow(/typed_attestation_phrase requires a non-empty attestationPhrase/);
  });

  it("rejects typed_attestation_phrase with a whitespace-only phrase", () => {
    expect(() =>
      DecisionAttestationSchema.parse({
        ...baseAttestation,
        kind: "typed_attestation_phrase",
        attestationPhrase: "   \t\n ",
      }),
    ).toThrow(/typed_attestation_phrase requires a non-empty attestationPhrase/);
  });

  it("requires a phrase of no kind but typed_attestation_phrase", () => {
    const needPhrase = ATTESTATION_KINDS.filter(
      (kind) =>
        !DecisionAttestationSchema.safeParse({
          ...baseAttestation,
          kind,
          // Satisfy every other kind's own evidence requirement, so the only clause left that
          // could refuse is the phrase one.
          signatureSha256: "a".repeat(64),
          signingKeyFingerprint: "b".repeat(64),
          coAttestingUserId: CO_ATTESTOR,
          coAttestedAt: "2026-04-15T10:05:00.000Z",
        }).success,
    );
    expect(needPhrase).toEqual(["typed_attestation_phrase"]);
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

  it("does not order attestation.attestedAt against decidedAt, because rowToDecision fills both from decided_at so such a clause could never fire for a stored row", () => {
    // Read the comment above `appliedAt` in decisions.ts before adding one. Both directions are
    // accepted deliberately: the two fields are one column, so a clause here would assert an
    // equality that holds by construction on every read and would legalise a rewrite of the
    // attestation instant rather than detect it.
    for (const attestedAt of [
      "2026-04-15T07:00:00.000Z",
      "2026-04-15T13:00:00.000Z",
    ]) {
      expect(
        AccessReviewDecisionSchema.safeParse({
          ...baseDecision,
          attestation: { ...baseAttestation, attestedAt },
        }).success,
      ).toBe(true);
    }
    // The family it is outside of does exist, and the sibling field that has a column of its own
    // is still ordered — so this test pins a decision rather than an absence of rules.
    expect(
      AccessReviewDecisionSchema.safeParse({
        ...baseDecision,
        appliedAt: "2026-04-15T09:00:00.000Z",
      }).success,
    ).toBe(false);
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
    expect(
      requiresStrongAttestation("time_bound_extend", "manager_attestation"),
    ).toBe(true);
  });
  it("security_concern_revoked requires strong", () => {
    expect(
      requiresStrongAttestation("revoke", "security_concern_revoked"),
    ).toBe(true);
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
