import { describe, expect, it } from "vitest";
import {
  ATTESTATION_KINDS,
  ATTESTOR_ROLES,
  AttestationRecordSchema,
  SIGNATURE_KINDS,
  attestationsForEvidence,
  isAttestationValid,
  isCourtAdmissible,
  type AttestationRecord,
} from "./attestations.js";

const SHA = "a".repeat(64);
const FP = "b".repeat(64);

describe("constants", () => {
  it("ATTESTATION_KINDS has 8 entries", () => {
    expect(ATTESTATION_KINDS).toContain("witness_to_collection");
    expect(ATTESTATION_KINDS).toContain("court_declaration");
    expect(ATTESTATION_KINDS).toContain("non_alteration_oath");
  });

  it("ATTESTOR_ROLES has 6 entries", () => {
    expect(ATTESTOR_ROLES).toContain("certified_forensic_examiner");
    expect(ATTESTOR_ROLES).toContain("notary_public");
  });

  it("SIGNATURE_KINDS has 5 entries", () => {
    expect(SIGNATURE_KINDS).toContain("notarized");
    expect(SIGNATURE_KINDS).toContain("qualified_electronic_signature");
  });
});

describe("AttestationRecordSchema", () => {
  const base: AttestationRecord = {
    id: "ATT-2026-0001",
    kind: "witness_to_collection",
    aboutEvidenceIds: ["EV-2026-0001"],
    matterReference: "case-1",
    statementBody: "I witnessed the collection",
    statementSha256: SHA,
    attestorUserId: "u-attestor",
    attestorRole: "internal_employee",
    signedAt: "2026-05-14T10:00:00Z",
    signatureKind: "platform_keypair",
    signatureBytes: "sig",
    signingKeyFingerprint: FP,
    counselWitnessUserId: null,
    isUnderOath: false,
    penaltyOfPerjuryAcknowledged: false,
    revokedAt: null,
    storageUri: "s3://attestations/att-2026-0001",
  };

  it("accepts a valid witness attestation", () => {
    expect(() => AttestationRecordSchema.parse(base)).not.toThrow();
  });

  it("rejects court_declaration without isUnderOath", () => {
    expect(() =>
      AttestationRecordSchema.parse({
        ...base,
        kind: "court_declaration",
        attestorRole: "external_counsel",
        signatureKind: "qualified_electronic_signature",
        attestorJurisdiction: "DE",
        counselWitnessUserId: "u-counsel",
        penaltyOfPerjuryAcknowledged: true,
      }),
    ).toThrow(/isUnderOath=true/);
  });

  it("rejects expert_analysis from internal_employee", () => {
    expect(() =>
      AttestationRecordSchema.parse({
        ...base,
        kind: "expert_analysis",
        attestorRole: "internal_employee",
        attestorCredentialReference: "CFE-12345",
      }),
    ).toThrow(/independent attestor/);
  });

  it("rejects expert_analysis without attestorCredentialReference", () => {
    expect(() =>
      AttestationRecordSchema.parse({
        ...base,
        kind: "expert_analysis",
        attestorRole: "certified_forensic_examiner",
      }),
    ).toThrow(/attestorCredentialReference/);
  });

  it("rejects notarized signature without notaryStampReference", () => {
    expect(() =>
      AttestationRecordSchema.parse({
        ...base,
        signatureKind: "notarized",
      }),
    ).toThrow(/notaryStampReference/);
  });

  it("rejects court_declaration without jurisdiction", () => {
    expect(() =>
      AttestationRecordSchema.parse({
        ...base,
        kind: "court_declaration",
        attestorRole: "external_counsel",
        signatureKind: "qualified_electronic_signature",
        counselWitnessUserId: "u-counsel",
        isUnderOath: true,
        penaltyOfPerjuryAcknowledged: true,
      }),
    ).toThrow(/attestorJurisdiction/);
  });

  it("rejects counselWitness == attestor", () => {
    expect(() =>
      AttestationRecordSchema.parse({
        ...base,
        kind: "court_declaration",
        attestorRole: "external_counsel",
        signatureKind: "qualified_electronic_signature",
        attestorJurisdiction: "DE",
        counselWitnessUserId: "u-attestor",
        isUnderOath: true,
        penaltyOfPerjuryAcknowledged: true,
      }),
    ).toThrow(/cannot be the attestor/);
  });

  it("rejects isUnderOath without notarized or qualified signature", () => {
    expect(() =>
      AttestationRecordSchema.parse({
        ...base,
        isUnderOath: true,
        penaltyOfPerjuryAcknowledged: true,
      }),
    ).toThrow(/notarized.*qualified_electronic_signature/);
  });

  it("rejects revokedAt without reason", () => {
    expect(() =>
      AttestationRecordSchema.parse({
        ...base,
        revokedAt: "2026-06-01T00:00:00Z",
      }),
    ).toThrow(/revokedReason/);
  });

  it("rejects duplicate evidence ids", () => {
    expect(() =>
      AttestationRecordSchema.parse({
        ...base,
        aboutEvidenceIds: ["EV-2026-0001", "EV-2026-0001"],
      }),
    ).toThrow(/duplicate evidence/);
  });

  it("rejects malformed attestation id", () => {
    expect(() => AttestationRecordSchema.parse({ ...base, id: "ATT-1" })).toThrow();
  });
});

describe("helpers", () => {
  const att: AttestationRecord = {
    id: "ATT-2026-0001",
    kind: "court_declaration",
    aboutEvidenceIds: ["EV-2026-0001"],
    matterReference: "case-1",
    statementBody: "x",
    statementSha256: SHA,
    attestorUserId: "u-attestor",
    attestorRole: "external_counsel",
    attestorJurisdiction: "DE",
    signedAt: "2026-05-14T10:00:00Z",
    signatureKind: "qualified_electronic_signature",
    signatureBytes: "sig",
    signingKeyFingerprint: FP,
    counselWitnessUserId: "u-counsel",
    isUnderOath: true,
    penaltyOfPerjuryAcknowledged: true,
    revokedAt: null,
    storageUri: "s3://x",
  };

  it("isAttestationValid true when not revoked", () => {
    expect(isAttestationValid(att)).toBe(true);
  });

  it("isAttestationValid false when revoked", () => {
    expect(
      isAttestationValid({
        ...att,
        revokedAt: "2026-06-01T00:00:00Z",
        revokedReason: "found error",
      }),
    ).toBe(false);
  });

  it("isCourtAdmissible true with oath + perjury + qualified signature", () => {
    expect(isCourtAdmissible(att)).toBe(true);
  });

  it("isCourtAdmissible false without oath", () => {
    expect(
      isCourtAdmissible({
        ...att,
        isUnderOath: false,
        signatureKind: "platform_keypair",
      }),
    ).toBe(false);
  });

  it("attestationsForEvidence filters by evidence id and excludes revoked", () => {
    const revoked = {
      ...att,
      id: "ATT-2026-0002",
      revokedAt: "2026-06-01T00:00:00Z",
      revokedReason: "x",
    };
    const other = {
      ...att,
      id: "ATT-2026-0003",
      aboutEvidenceIds: ["EV-2026-0099"],
    };
    expect(attestationsForEvidence([att, revoked, other], "EV-2026-0001").map((a) => a.id)).toEqual(
      ["ATT-2026-0001"],
    );
  });
});
