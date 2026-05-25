import { z } from "zod";

export const DECISION_KINDS = [
  "keep",
  "revoke",
  "time_bound_extend",
  "modify_grant",
  "defer_to_next_campaign",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const DECISION_REASONS = [
  "role_appropriate",
  "last_login_recent",
  "business_justification_attested",
  "compliance_attestation",
  "manager_attestation",
  "regulatory_requirement",
  "no_response_auto_default",
  "security_concern_revoked",
  "role_changed_modified",
  "promotion_modified",
  "departure_revoked",
  "duplicate_access_revoked",
  "unused_access_revoked",
  "principal_no_longer_in_scope",
] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];

export const ATTESTATION_KINDS = [
  "click_through_acknowledgement",
  "typed_attestation_phrase",
  "e_signature_digital",
  "qualified_e_signature",
  "two_person_attestation",
] as const;
export type AttestationKind = (typeof ATTESTATION_KINDS)[number];

export const STRONG_ATTESTATION_KINDS: ReadonlySet<AttestationKind> = new Set([
  "e_signature_digital",
  "qualified_e_signature",
  "two_person_attestation",
]);

export const REASONS_REQUIRING_REVOKE: ReadonlySet<DecisionReason> = new Set([
  "security_concern_revoked",
  "departure_revoked",
  "duplicate_access_revoked",
  "unused_access_revoked",
]);

export const REASONS_REQUIRING_KEEP: ReadonlySet<DecisionReason> = new Set([
  "role_appropriate",
  "last_login_recent",
  "business_justification_attested",
  "compliance_attestation",
  "manager_attestation",
  "regulatory_requirement",
]);

export const DecisionAttestationSchema = z
  .object({
    kind: z.enum(ATTESTATION_KINDS),
    attestedAt: z.string().datetime({ offset: true }),
    attestedByUserId: z.string().uuid(),
    attestationPhrase: z.string().max(500).optional(),
    signatureSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    signingKeyFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    coAttestingUserId: z.string().uuid().nullable(),
    coAttestedAt: z.string().datetime({ offset: true }).nullable(),
    ipAddress: z.string().min(1).max(45),
    userAgent: z.string().max(512),
  })
  .superRefine((a, ctx) => {
    if (
      (a.kind === "e_signature_digital" || a.kind === "qualified_e_signature") &&
      (a.signatureSha256 === null || a.signingKeyFingerprint === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signatureSha256"],
        message: `${a.kind} requires signatureSha256 and signingKeyFingerprint`,
      });
    }
    if (
      a.kind === "two_person_attestation" &&
      (a.coAttestingUserId === null || a.coAttestedAt === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coAttestingUserId"],
        message: "two_person_attestation requires coAttestingUserId + coAttestedAt",
      });
    }
    if (a.coAttestingUserId === a.attestedByUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coAttestingUserId"],
        message: "co-attestor must differ from primary attestor",
      });
    }
  });
export type DecisionAttestation = z.infer<typeof DecisionAttestationSchema>;

export const AccessReviewDecisionSchema = z
  .object({
    id: z.string().regex(/^ard_[a-z0-9]{8,32}$/),
    itemId: z.string().regex(/^ari_[a-z0-9]{8,32}$/),
    campaignId: z.string().regex(/^arc_[a-z0-9]{8,32}$/),
    tenantId: z.string().uuid(),
    decidedByUserId: z.string().uuid(),
    decidedAt: z.string().datetime({ offset: true }),
    kind: z.enum(DECISION_KINDS),
    reason: z.enum(DECISION_REASONS),
    comment: z.string().max(2000).optional(),
    timeBoundExtendUntil: z.string().datetime({ offset: true }).nullable(),
    modifiedGrantAttributes: z.record(z.string(), z.string()).nullable(),
    attestation: DecisionAttestationSchema,
    supersedesDecisionId: z.string().nullable(),
    relatedExceptionId: z.string().nullable(),
    appliedAt: z.string().datetime({ offset: true }).nullable(),
    applicationFailedAt: z.string().datetime({ offset: true }).nullable(),
    applicationFailureReason: z.string().max(500).nullable(),
  })
  .superRefine((d, ctx) => {
    if (d.decidedByUserId !== d.attestation.attestedByUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attestation", "attestedByUserId"],
        message: "decidedByUserId must match attestation.attestedByUserId",
      });
    }
    if (d.kind === "time_bound_extend" && d.timeBoundExtendUntil === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeBoundExtendUntil"],
        message: "time_bound_extend decision requires timeBoundExtendUntil",
      });
    }
    if (d.kind === "modify_grant" && d.modifiedGrantAttributes === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modifiedGrantAttributes"],
        message: "modify_grant decision requires modifiedGrantAttributes",
      });
    }
    if (d.kind === "keep" && REASONS_REQUIRING_REVOKE.has(d.reason)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: `keep decision is inconsistent with reason ${d.reason}`,
      });
    }
    if (d.kind === "revoke" && REASONS_REQUIRING_KEEP.has(d.reason)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: `revoke decision is inconsistent with reason ${d.reason}`,
      });
    }
    if (
      d.timeBoundExtendUntil !== null &&
      Date.parse(d.timeBoundExtendUntil) <= Date.parse(d.decidedAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeBoundExtendUntil"],
        message: "timeBoundExtendUntil must be after decidedAt",
      });
    }
    if (d.appliedAt !== null && Date.parse(d.appliedAt) < Date.parse(d.decidedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["appliedAt"],
        message: "appliedAt cannot precede decidedAt",
      });
    }
    if (d.applicationFailedAt !== null && d.applicationFailureReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applicationFailureReason"],
        message: "applicationFailedAt requires applicationFailureReason",
      });
    }
  });
export type AccessReviewDecision = z.infer<typeof AccessReviewDecisionSchema>;

export const isStrongAttestation = (attestation: DecisionAttestation): boolean =>
  STRONG_ATTESTATION_KINDS.has(attestation.kind);

export const requiresStrongAttestation = (kind: DecisionKind, reason: DecisionReason): boolean => {
  if (kind === "keep" && reason === "regulatory_requirement") return true;
  if (kind === "time_bound_extend") return true;
  if (reason === "security_concern_revoked") return true;
  return false;
};

export const supersedeDecision = (
  prior: AccessReviewDecision,
  next: Omit<AccessReviewDecision, "supersedesDecisionId">,
): AccessReviewDecision => {
  return { ...next, supersedesDecisionId: prior.id };
};
