import { z } from "zod";
import type { LineageNode } from "./nodes.js";

export const RETENTION_BASES = [
  "tenant_policy",
  "regulatory_minimum",
  "customer_request",
  "indefinite_legal_hold",
  "contract_duration",
  "consent_grant_period",
] as const;
export type RetentionBasis = (typeof RETENTION_BASES)[number];

export const REGULATORY_RETENTION_MINIMUMS_DAYS: Readonly<Record<string, number>> = {
  hipaa_phi: 6 * 365,
  sox_financial: 7 * 365,
  pci_dss: 1 * 365,
  gdpr_default: 0,
  cfr_21_part_11_records: 10 * 365,
  fda_clinical_trial: 25 * 365,
};

export const RetentionPolicySchema = z
  .object({
    id: z.string().regex(/^lrp_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    label: z.string().min(1).max(200),
    basis: z.enum(RETENTION_BASES),
    minimumRetentionDays: z.number().int().min(0).max(36_500),
    maximumRetentionDays: z.number().int().min(0).max(36_500).nullable(),
    appliesToNodeKinds: z.array(z.string().max(80)).default([]),
    appliesToClassifications: z.array(z.string().max(40)).default([]),
    regulatoryReference: z.string().max(200).nullable(),
    blocksAutoDeletion: z.boolean(),
    purgeAfterExpiry: z.boolean(),
    enabledAt: z.string().datetime({ offset: true }),
    enabledByUserId: z.string().uuid(),
    disabledAt: z.string().datetime({ offset: true }).nullable(),
    disabledByUserId: z.string().uuid().nullable(),
    disabledReason: z.string().max(500).nullable(),
  })
  .superRefine((p, ctx) => {
    if (p.maximumRetentionDays !== null && p.maximumRetentionDays < p.minimumRetentionDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maximumRetentionDays"],
        message: "maximumRetentionDays must be >= minimumRetentionDays",
      });
    }
    if (p.basis === "regulatory_minimum" && p.regulatoryReference === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["regulatoryReference"],
        message: "regulatory_minimum basis requires regulatoryReference (citation)",
      });
    }
    if (
      p.basis === "indefinite_legal_hold" &&
      (p.maximumRetentionDays !== null || !p.blocksAutoDeletion)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maximumRetentionDays"],
        message:
          "indefinite_legal_hold must have null maximumRetentionDays + blocksAutoDeletion=true",
      });
    }
    if (p.disabledAt !== null) {
      if (p.disabledByUserId === null || p.disabledReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["disabledByUserId"],
          message: "disabled policy requires disabledByUserId + disabledReason",
        });
      }
      if (p.disabledByUserId === p.enabledByUserId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["disabledByUserId"],
          message: "four-eyes: disabledByUserId must differ from enabledByUserId",
        });
      }
    }
  });
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export const isPolicyActive = (policy: RetentionPolicy, now: Date): boolean => {
  if (policy.disabledAt !== null) return false;
  return now.getTime() >= Date.parse(policy.enabledAt);
};

export const computeNodeRetentionUntil = (node: LineageNode, policy: RetentionPolicy): string => {
  const createdMs = Date.parse(node.createdAt);
  const minMs = createdMs + policy.minimumRetentionDays * 86_400_000;
  if (policy.maximumRetentionDays === null) {
    return new Date(minMs).toISOString();
  }
  const maxMs = createdMs + policy.maximumRetentionDays * 86_400_000;
  return new Date(Math.max(minMs, maxMs)).toISOString();
};

export const ARTICLE_15_EVIDENCE_STATUSES = [
  "compiling",
  "sealed",
  "delivered",
  "expired",
] as const;
export type Article15EvidenceStatus = (typeof ARTICLE_15_EVIDENCE_STATUSES)[number];

export const Article15EvidencePackSchema = z
  .object({
    id: z.string().regex(/^a15_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid(),
    subjectAccessRequestId: z.string().regex(/^sar_[a-z0-9]{8,40}$/),
    subjectId: z.string().regex(/^ds_[a-z0-9]{8,40}$/),
    status: z.enum(ARTICLE_15_EVIDENCE_STATUSES),
    nodeIds: z.array(z.string().regex(/^lng_[a-z0-9]{8,40}$/)).min(0),
    edgeIds: z.array(z.string().regex(/^lne_[a-z0-9]{8,40}$/)).default([]),
    provenanceRecordIds: z.array(z.string().regex(/^prv_[a-z0-9]{8,40}$/)).default([]),
    totalRowCount: z.number().int().min(0),
    derivedNodeCount: z.number().int().min(0),
    regulatedNodeCount: z.number().int().min(0),
    compiledAt: z.string().datetime({ offset: true }).nullable(),
    sealedAt: z.string().datetime({ offset: true }).nullable(),
    sealedSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    storageUri: z.string().min(1).max(500).nullable(),
    encryptionKeyFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    deliveredAt: z.string().datetime({ offset: true }).nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    redactedPiiFields: z.array(z.string().max(120)).default([]),
    redactedReasons: z.array(z.string().max(200)).default([]),
    createdByUserId: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .superRefine((p, ctx) => {
    if (p.status === "sealed" || p.status === "delivered") {
      if (
        p.sealedAt === null ||
        p.sealedSha256 === null ||
        p.storageUri === null ||
        p.encryptionKeyFingerprint === null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sealedSha256"],
          message:
            "sealed/delivered pack requires sealedAt + sealedSha256 + storageUri + encryptionKeyFingerprint",
        });
      }
    }
    if (p.status === "delivered" && p.deliveredAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliveredAt"],
        message: "delivered pack requires deliveredAt",
      });
    }
    if (
      p.expiresAt !== null &&
      p.sealedAt !== null &&
      Date.parse(p.expiresAt) <= Date.parse(p.sealedAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after sealedAt",
      });
    }
    if (p.redactedPiiFields.length !== p.redactedReasons.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["redactedReasons"],
        message: "redactedPiiFields and redactedReasons must have equal length",
      });
    }
  });
export type Article15EvidencePack = z.infer<typeof Article15EvidencePackSchema>;

export const isPackDownloadable = (pack: Article15EvidencePack, now: Date): boolean => {
  if (pack.status !== "sealed" && pack.status !== "delivered") return false;
  if (pack.expiresAt === null) return true;
  return now.getTime() < Date.parse(pack.expiresAt);
};

export interface RetentionDecisionInput {
  readonly node: LineageNode;
  readonly applicablePolicies: readonly RetentionPolicy[];
  readonly now: Date;
}

export interface RetentionDecision {
  readonly canPurge: boolean;
  readonly reason: string;
  readonly blockingPolicyId: string | null;
  readonly effectiveRetentionUntil: string | null;
}

export const decideRetention = (input: RetentionDecisionInput): RetentionDecision => {
  const nowMs = input.now.getTime();
  let latestRetention = 0;
  let blockingPolicy: RetentionPolicy | null = null;
  for (const p of input.applicablePolicies) {
    if (!isPolicyActive(p, input.now)) continue;
    if (p.blocksAutoDeletion) {
      const until = computeNodeRetentionUntil(input.node, p);
      const untilMs = Date.parse(until);
      if (untilMs > latestRetention) {
        latestRetention = untilMs;
        blockingPolicy = p;
      }
    }
  }
  if (blockingPolicy !== null && nowMs < latestRetention) {
    return {
      canPurge: false,
      reason: `blocked_by_policy_${blockingPolicy.id}`,
      blockingPolicyId: blockingPolicy.id,
      effectiveRetentionUntil: new Date(latestRetention).toISOString(),
    };
  }
  if (input.node.retentionUntil !== null && nowMs < Date.parse(input.node.retentionUntil)) {
    return {
      canPurge: false,
      reason: "blocked_by_node_retention_until",
      blockingPolicyId: null,
      effectiveRetentionUntil: input.node.retentionUntil,
    };
  }
  return {
    canPurge: true,
    reason: "retention_satisfied",
    blockingPolicyId: null,
    effectiveRetentionUntil: null,
  };
};
