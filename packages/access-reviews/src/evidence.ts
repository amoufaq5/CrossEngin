import { z } from "zod";
import { COMPLIANCE_FRAMEWORKS } from "./campaigns.js";

export const EVIDENCE_STATUSES = [
  "draft",
  "compiled",
  "sealed",
  "submitted_to_auditor",
  "accepted_by_auditor",
  "rejected_by_auditor",
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const EVIDENCE_TRANSITIONS: Readonly<Record<EvidenceStatus, readonly EvidenceStatus[]>> = {
  draft: ["compiled"],
  compiled: ["sealed"],
  sealed: ["submitted_to_auditor"],
  submitted_to_auditor: ["accepted_by_auditor", "rejected_by_auditor"],
  accepted_by_auditor: [],
  rejected_by_auditor: ["draft"],
};

export const canTransitionEvidence = (from: EvidenceStatus, to: EvidenceStatus): boolean =>
  EVIDENCE_TRANSITIONS[from].includes(to);

export const CONTROL_MAPPINGS: Readonly<Record<string, readonly string[]>> = {
  soc2_type2: ["CC6.1", "CC6.2", "CC6.3", "CC6.7"],
  iso27001: ["A.5.18", "A.5.15", "A.9.2.5"],
  hipaa_security_rule: ["164.308(a)(3)(ii)(B)", "164.308(a)(4)(ii)(C)", "164.312(a)(1)"],
  pci_dss_v4: ["7.2.4", "7.2.5", "7.2.6"],
  gdpr_article_32: ["Art.32.1.b", "Art.32.4"],
  cfr_21_part_11: ["11.10(d)", "11.10(g)", "11.10(j)"],
  custom: [],
};

export const computeCampaignEvidenceMetrics = (input: {
  readonly totalItems: number;
  readonly decidedItems: number;
  readonly keepDecisions: number;
  readonly revokeDecisions: number;
  readonly extendDecisions: number;
  readonly modifyDecisions: number;
  readonly deferDecisions: number;
  readonly autoRevokedItems: number;
  readonly exceptionItems: number;
  readonly approvedExceptionItems: number;
  readonly strongAttestationCount: number;
  readonly overdueAtCompletion: number;
}): {
  readonly completionRate: number;
  readonly keepRate: number;
  readonly revokeRate: number;
  readonly autoRevokeRate: number;
  readonly exceptionRate: number;
  readonly strongAttestationRate: number;
  readonly overdueRate: number;
} => {
  const total = input.totalItems;
  if (total === 0) {
    return {
      completionRate: 1,
      keepRate: 0,
      revokeRate: 0,
      autoRevokeRate: 0,
      exceptionRate: 0,
      strongAttestationRate: 0,
      overdueRate: 0,
    };
  }
  const resolved = input.decidedItems + input.autoRevokedItems + input.exceptionItems;
  const decidedNonZero = Math.max(1, input.decidedItems);
  return {
    completionRate: resolved / total,
    keepRate: input.keepDecisions / decidedNonZero,
    revokeRate: input.revokeDecisions / decidedNonZero,
    autoRevokeRate: input.autoRevokedItems / total,
    exceptionRate: input.exceptionItems / total,
    strongAttestationRate:
      input.decidedItems === 0 ? 0 : input.strongAttestationCount / input.decidedItems,
    overdueRate: input.overdueAtCompletion / total,
  };
};

export const AccessReviewEvidenceSchema = z
  .object({
    id: z.string().regex(/^arv_[a-z0-9]{8,32}$/),
    tenantId: z.string().uuid(),
    framework: z.enum(COMPLIANCE_FRAMEWORKS),
    periodStartAt: z.string().datetime({ offset: true }),
    periodEndAt: z.string().datetime({ offset: true }),
    campaignIds: z.array(z.string().regex(/^arc_[a-z0-9]{8,32}$/)).min(1),
    controlMappings: z.array(z.string()).min(1),
    totalItemsAcrossCampaigns: z.number().int().min(0),
    completionRate: z.number().min(0).max(1),
    keepRate: z.number().min(0).max(1),
    revokeRate: z.number().min(0).max(1),
    autoRevokeRate: z.number().min(0).max(1),
    exceptionRate: z.number().min(0).max(1),
    strongAttestationRate: z.number().min(0).max(1),
    overdueRate: z.number().min(0).max(1),
    status: z.enum(EVIDENCE_STATUSES),
    compiledAt: z.string().datetime({ offset: true }).nullable(),
    sealedAt: z.string().datetime({ offset: true }).nullable(),
    sealedSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    submittedAt: z.string().datetime({ offset: true }).nullable(),
    submittedToAuditorId: z.string().min(1).max(200).nullable(),
    acceptedAt: z.string().datetime({ offset: true }).nullable(),
    rejectedAt: z.string().datetime({ offset: true }).nullable(),
    rejectedReason: z.string().max(2000).nullable(),
    storageUri: z.string().min(1).max(500).nullable(),
    createdBy: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .superRefine((e, ctx) => {
    if (Date.parse(e.periodEndAt) <= Date.parse(e.periodStartAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["periodEndAt"],
        message: "periodEndAt must be after periodStartAt",
      });
    }
    if (
      (e.status === "sealed" ||
        e.status === "submitted_to_auditor" ||
        e.status === "accepted_by_auditor") &&
      (e.sealedAt === null || e.sealedSha256 === null || e.storageUri === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sealedSha256"],
        message: `${e.status} status requires sealedAt + sealedSha256 + storageUri`,
      });
    }
    if (
      e.status === "submitted_to_auditor" &&
      (e.submittedAt === null || e.submittedToAuditorId === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["submittedAt"],
        message: "submitted_to_auditor status requires submittedAt + submittedToAuditorId",
      });
    }
    if (
      e.status === "rejected_by_auditor" &&
      (e.rejectedAt === null || e.rejectedReason === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rejectedReason"],
        message: "rejected_by_auditor status requires rejectedAt + rejectedReason",
      });
    }
    if (e.status === "accepted_by_auditor" && e.acceptedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptedAt"],
        message: "accepted_by_auditor status requires acceptedAt",
      });
    }
    const expectedControls = CONTROL_MAPPINGS[e.framework] ?? [];
    if (expectedControls.length > 0) {
      const hasAtLeastOneExpected = expectedControls.some((c) => e.controlMappings.includes(c));
      if (!hasAtLeastOneExpected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["controlMappings"],
          message: `controlMappings must include at least one control from ${expectedControls.join(", ")}`,
        });
      }
    }
  });
export type AccessReviewEvidence = z.infer<typeof AccessReviewEvidenceSchema>;

export const sealEvidence = (
  evidence: AccessReviewEvidence,
  sha256: string,
  storageUri: string,
  now: Date,
): AccessReviewEvidence => {
  if (!canTransitionEvidence(evidence.status, "sealed")) {
    throw new Error(`cannot transition evidence from ${evidence.status} to sealed`);
  }
  return {
    ...evidence,
    status: "sealed",
    sealedAt: now.toISOString(),
    sealedSha256: sha256,
    storageUri,
  };
};

export const isEvidenceComplete = (evidence: AccessReviewEvidence): boolean =>
  evidence.status === "submitted_to_auditor" || evidence.status === "accepted_by_auditor";
