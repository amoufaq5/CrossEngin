import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;
const ATTESTATION_ID_REGEX = /^ATT-\d{4}-\d{4,8}$/;

export const ATTESTATION_KINDS = [
  "witness_to_collection",
  "witness_to_transfer",
  "expert_analysis",
  "authenticity_certification",
  "completeness_certification",
  "non_alteration_oath",
  "privilege_log_review",
  "court_declaration",
] as const;
export type AttestationKind = (typeof ATTESTATION_KINDS)[number];
export const AttestationKindSchema = z.enum(ATTESTATION_KINDS);

export const ATTESTOR_ROLES = [
  "internal_employee",
  "external_counsel",
  "certified_forensic_examiner",
  "neutral_third_party",
  "notary_public",
  "court_appointed_master",
] as const;
export type AttestorRole = (typeof ATTESTOR_ROLES)[number];

export const SIGNATURE_KINDS = [
  "platform_keypair",
  "pgp_keypair",
  "qualified_electronic_signature",
  "wet_signature_scan",
  "notarized",
] as const;
export type SignatureKind = (typeof SIGNATURE_KINDS)[number];

const COURT_REQUIRED_KINDS: ReadonlySet<AttestationKind> = new Set([
  "court_declaration",
  "non_alteration_oath",
]);

const REQUIRES_INDEPENDENT_ROLE: ReadonlySet<AttestationKind> = new Set([
  "authenticity_certification",
  "expert_analysis",
  "completeness_certification",
  "court_declaration",
]);

export const AttestationRecordSchema = z
  .object({
    id: z.string().regex(ATTESTATION_ID_REGEX, {
      message: "attestation id must match 'ATT-YYYY-NNNN'",
    }),
    kind: AttestationKindSchema,
    aboutEvidenceIds: z.array(z.string().min(1)).min(1),
    matterReference: z.string().min(1),
    statementBody: z.string().min(1).max(50_000),
    statementSha256: z.string().regex(SHA256_REGEX),
    attestorUserId: z.string().min(1),
    attestorRole: z.enum(ATTESTOR_ROLES),
    attestorJurisdiction: z.string().min(1).optional(),
    attestorCredentialReference: z.string().min(1).optional(),
    signedAt: Iso8601,
    signatureKind: z.enum(SIGNATURE_KINDS),
    signatureBytes: z.string().min(1),
    signingKeyFingerprint: z.string().regex(SHA256_REGEX),
    notaryStampReference: z.string().min(1).optional(),
    counselWitnessUserId: z.string().min(1).nullable().default(null),
    isUnderOath: z.boolean(),
    penaltyOfPerjuryAcknowledged: z.boolean(),
    revokedAt: Iso8601.nullable().default(null),
    revokedReason: z.string().min(1).optional(),
    storageUri: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    if (COURT_REQUIRED_KINDS.has(v.kind)) {
      if (!v.isUnderOath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["isUnderOath"],
          message: `kind '${v.kind}' requires isUnderOath=true`,
        });
      }
      if (!v.penaltyOfPerjuryAcknowledged) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["penaltyOfPerjuryAcknowledged"],
          message: `kind '${v.kind}' requires penaltyOfPerjuryAcknowledged=true`,
        });
      }
    }
    if (REQUIRES_INDEPENDENT_ROLE.has(v.kind)) {
      if (v.attestorRole === "internal_employee") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["attestorRole"],
          message: `kind '${v.kind}' requires an independent attestor (not internal_employee)`,
        });
      }
    }
    if (v.kind === "expert_analysis" && v.attestorCredentialReference === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attestorCredentialReference"],
        message: "expert_analysis requires attestorCredentialReference",
      });
    }
    if (v.signatureKind === "notarized" && v.notaryStampReference === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["notaryStampReference"],
        message: "notarized signature requires notaryStampReference",
      });
    }
    if (v.kind === "court_declaration") {
      if (v.attestorJurisdiction === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["attestorJurisdiction"],
          message: "court_declaration requires attestorJurisdiction",
        });
      }
      if (v.counselWitnessUserId === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["counselWitnessUserId"],
          message: "court_declaration requires counselWitnessUserId",
        });
      }
    }
    if (v.counselWitnessUserId !== null && v.counselWitnessUserId === v.attestorUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["counselWitnessUserId"],
        message: "counselWitnessUserId cannot be the attestor",
      });
    }
    if (v.revokedAt !== null && v.revokedReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revokedReason"],
        message: "revokedAt requires revokedReason",
      });
    }
    if (
      v.isUnderOath &&
      v.signatureKind !== "notarized" &&
      v.signatureKind !== "qualified_electronic_signature"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signatureKind"],
        message:
          "isUnderOath requires signatureKind='notarized' or 'qualified_electronic_signature'",
      });
    }
    const evidenceIds = new Set<string>();
    v.aboutEvidenceIds.forEach((e, i) => {
      if (evidenceIds.has(e)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["aboutEvidenceIds", i],
          message: `duplicate evidence id '${e}'`,
        });
      }
      evidenceIds.add(e);
    });
  });
export type AttestationRecord = z.infer<typeof AttestationRecordSchema>;

export function isAttestationValid(att: AttestationRecord): boolean {
  return att.revokedAt === null;
}

export function isCourtAdmissible(att: AttestationRecord): boolean {
  if (att.revokedAt !== null) return false;
  if (!att.isUnderOath) return false;
  if (!att.penaltyOfPerjuryAcknowledged) return false;
  return (
    att.signatureKind === "notarized" || att.signatureKind === "qualified_electronic_signature"
  );
}

export function attestationsForEvidence(
  attestations: readonly AttestationRecord[],
  evidenceId: string,
): readonly AttestationRecord[] {
  return attestations.filter(
    (a) => a.revokedAt === null && a.aboutEvidenceIds.includes(evidenceId),
  );
}
