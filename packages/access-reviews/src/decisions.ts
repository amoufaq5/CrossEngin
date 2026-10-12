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
    signatureSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    signingKeyFingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
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
    // The only evidence this kind carries: there is no signature, no co-attestor and no second
    // factor, so an attestation of this kind with no phrase records that somebody clicked — which
    // is `click_through_acknowledgement` under a name asserting more. Coupled to the
    // `attestation_phrase` column landing in the same increment: the phrase had nowhere to live,
    // and with the clause but not the column a `typed_attestation_phrase` row would be writable
    // and not readable — the authored record carries the phrase, the stored row drops it, so
    // `rowToDecision` would hand back a record this clause refuses. Neither half ships alone.
    if (
      a.kind === "typed_attestation_phrase" &&
      (a.attestationPhrase === undefined || a.attestationPhrase.trim() === "")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attestationPhrase"],
        message: "typed_attestation_phrase requires a non-empty attestationPhrase",
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
    // This one binds *stored* rows, which is what earns it a place where an
    // `attestedAt`-vs-`decidedAt` clause would not: `co_attested_at` is a real column that
    // `PostgresAccessReviewDecisionStore.record` binds and `rowToDecision` reads back, so a
    // four-eyes record whose co-attestation predates the primary one is refused on the way in
    // *and* reported on the way out. `attestedAt` has no column — the mapper fills it from
    // `decided_at` — so a clause over that pair could never fire for a stored decision; see the
    // note in `AccessReviewDecisionSchema` below.
    //
    // Not a CHECK constraint instead, for two reasons: which fields a kind requires is
    // `attestation_kind`-dependent, so this family is not expressible column by column; and the
    // right-hand side of this very comparison has no column, so the nearest CHECK
    // (`co_attested_at >= decided_at`) is a different predicate that only agrees with this one
    // because the mapper collapses the two instants.
    //
    // Guarded by shape and not by `=== null`, because `Date.parse(undefined)` is NaN and every
    // comparison against NaN is false — so a later `.optional()` here would turn the refusal into
    // a silent accept, which is this increment's own class.
    if (
      typeof a.coAttestedAt === "string" &&
      Date.parse(a.coAttestedAt) < Date.parse(a.attestedAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coAttestedAt"],
        message: "coAttestedAt cannot precede attestedAt",
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
    if (
      d.kind === "keep" &&
      REASONS_REQUIRING_REVOKE.has(d.reason)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: `keep decision is inconsistent with reason ${d.reason}`,
      });
    }
    if (
      d.kind === "revoke" &&
      REASONS_REQUIRING_KEEP.has(d.reason)
    ) {
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
    if (
      d.appliedAt !== null &&
      Date.parse(d.appliedAt) < Date.parse(d.decidedAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["appliedAt"],
        message: "appliedAt cannot precede decidedAt",
      });
    }
    // `attestation.attestedAt` is deliberately *not* ordered against `decidedAt`, and it is the
    // one member of this family that must stay out of it. `rowToDecision` fills `decidedAt` and
    // `attestation.attestedAt` from the same column, `decided_at`, so the equality holds by
    // construction on every read: a clause here could never fire for a stored decision, and
    // asserting it would declare the unstored field equal to the stored one — making a silent
    // rewrite of the attestation instant legal *by definition* rather than detecting it. A control
    // that cannot fail is worse than none, because a report citing it claims an examination that
    // never happened (ADR-0337). Closing it means giving `attested_at` a column of its own, and
    // the measured argument against that is in `meta-schema.ts` beside `attestation_phrase`, which
    // got one for the opposite reason: a phrase duplicates nothing.
    if (d.applicationFailedAt !== null && d.applicationFailureReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applicationFailureReason"],
        message: "applicationFailedAt requires applicationFailureReason",
      });
    }
  });
export type AccessReviewDecision = z.infer<typeof AccessReviewDecisionSchema>;

export const isStrongAttestation = (
  attestation: DecisionAttestation,
): boolean => STRONG_ATTESTATION_KINDS.has(attestation.kind);

export const requiresStrongAttestation = (
  kind: DecisionKind,
  reason: DecisionReason,
): boolean => {
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
