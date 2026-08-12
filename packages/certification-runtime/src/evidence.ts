import { z } from "zod";
import type { ComplianceFramework } from "@crossengin/access-reviews";
import { EVIDENCE_SOURCE_KINDS } from "./controls.js";

export const ControlEvidenceSchema = z
  .object({
    controlId: z.string().min(1),
    sourceKind: z.enum(EVIDENCE_SOURCE_KINDS),
    satisfied: z.boolean(),
    summary: z.string().min(1),
    findings: z.array(z.string().min(1)),
    observedAt: z.string().datetime(),
    detailRef: z.string().min(1).nullable(),
  })
  .strict();
export type ControlEvidence = z.infer<typeof ControlEvidenceSchema>;

/** Structural view of `EncryptionCoverageReport` from `@crossengin/kernel-pg`. */
export interface EncryptionCoverageLike {
  readonly schema: string;
  readonly pgcryptoInstalled: boolean;
  readonly total: number;
  readonly plaintext: number;
  readonly issues: readonly { readonly kind: string; readonly detail: string }[];
}

/** Structural view of `DrReadinessReport` from `@crossengin/dr-runtime`. */
export interface DrReadinessLike {
  readonly ready: boolean;
  readonly counts: {
    readonly totalIssues: number;
    readonly overdueDrills?: number;
    readonly staleRunbooks?: number;
    readonly expiredBackups?: number;
    readonly unverifiedBackups?: number;
    readonly failoverBreaches?: number;
    readonly drillBreaches?: number;
  };
}

/** Structural view of `AccessReviewEvidence` from `@crossengin/access-reviews`. */
export interface AccessReviewEvidenceLike {
  readonly framework: ComplianceFramework;
  readonly status: string;
  readonly sealedSha256: string | null;
  readonly completionRate: number;
  readonly strongAttestationRate: number;
  readonly controlMappings: readonly string[];
}

/** Structural view of `verifyChainIntegrity(...)` from `@crossengin/forensics`. */
export interface ForensicChainLike {
  readonly valid: boolean;
  readonly brokenAt: number | null;
  readonly reason?: string | null;
}

const SEALED_EVIDENCE_STATUSES: ReadonlySet<string> = new Set([
  "sealed",
  "submitted_to_auditor",
  "accepted_by_auditor",
]);

export const DEFAULT_MIN_COMPLETION_RATE = 0.95;

export function evidenceFromEncryptionCoverage(
  controlId: string,
  report: EncryptionCoverageLike,
  observedAt: string,
): ControlEvidence {
  const findings = report.issues.map((i) => `${i.kind}: ${i.detail}`);
  const satisfied = findings.length === 0;
  return ControlEvidenceSchema.parse({
    controlId,
    sourceKind: "encryption_coverage",
    satisfied,
    summary: satisfied
      ? `${report.total.toString()} at-rest column(s) in ${report.schema} are ciphertext; pgcrypto installed`
      : `${report.plaintext.toString()} of ${report.total.toString()} at-rest column(s) in ${report.schema} are plaintext or pgcrypto is missing`,
    findings,
    observedAt,
    detailRef: report.schema,
  });
}

export function evidenceFromDrReadiness(
  controlId: string,
  report: DrReadinessLike,
  observedAt: string,
): ControlEvidence {
  const findings: string[] = [];
  if (!report.ready) {
    findings.push(`${report.counts.totalIssues.toString()} DR readiness issue(s)`);
    const c = report.counts;
    if (c.overdueDrills) findings.push(`overdue drills: ${c.overdueDrills.toString()}`);
    if (c.staleRunbooks) findings.push(`stale runbooks: ${c.staleRunbooks.toString()}`);
    if (c.expiredBackups) findings.push(`expired backups: ${c.expiredBackups.toString()}`);
    if (c.unverifiedBackups)
      findings.push(`unverified backups: ${c.unverifiedBackups.toString()}`);
    if (c.failoverBreaches)
      findings.push(`failover RPO/RTO breaches: ${c.failoverBreaches.toString()}`);
    if (c.drillBreaches)
      findings.push(`drill RPO/RTO breaches: ${c.drillBreaches.toString()}`);
  }
  return ControlEvidenceSchema.parse({
    controlId,
    sourceKind: "dr_readiness",
    satisfied: report.ready,
    summary: report.ready
      ? "DR readiness: READY (0 issues)"
      : `DR readiness: NOT READY (${report.counts.totalIssues.toString()} issue(s))`,
    findings,
    observedAt,
    detailRef: null,
  });
}

export function evidenceFromForensicChain(
  controlId: string,
  result: ForensicChainLike,
  observedAt: string,
): ControlEvidence {
  const findings: string[] = [];
  if (!result.valid) {
    const at = result.brokenAt === null ? "?" : result.brokenAt.toString();
    findings.push(
      `chain broken at sequence ${at}${result.reason ? `: ${result.reason}` : ""}`,
    );
  }
  return ControlEvidenceSchema.parse({
    controlId,
    sourceKind: "forensic_chain",
    satisfied: result.valid,
    summary: result.valid
      ? "audit hash-chain integrity verified"
      : "audit hash-chain integrity FAILED",
    findings,
    observedAt,
    detailRef: null,
  });
}

export interface AccessReviewEvidenceOptions {
  readonly minCompletionRate?: number;
  readonly requireSeal?: boolean;
}

export function evidenceFromAccessReviewEvidence(
  controlId: string,
  evidence: AccessReviewEvidenceLike,
  observedAt: string,
  options: AccessReviewEvidenceOptions = {},
): ControlEvidence {
  const minCompletion = options.minCompletionRate ?? DEFAULT_MIN_COMPLETION_RATE;
  const requireSeal = options.requireSeal ?? true;
  const findings: string[] = [];
  const sealed = SEALED_EVIDENCE_STATUSES.has(evidence.status);
  if (requireSeal && (!sealed || evidence.sealedSha256 === null)) {
    findings.push(`evidence not sealed (status=${evidence.status})`);
  }
  if (evidence.completionRate < minCompletion) {
    findings.push(
      `completion rate ${evidence.completionRate.toFixed(2)} below ${minCompletion.toFixed(2)}`,
    );
  }
  const satisfied = findings.length === 0;
  return ControlEvidenceSchema.parse({
    controlId,
    sourceKind: "access_review_campaign",
    satisfied,
    summary: satisfied
      ? `${evidence.framework} access review sealed at ${(evidence.completionRate * 100).toFixed(0)}% completion`
      : `${evidence.framework} access review deficient`,
    findings,
    observedAt,
    detailRef: evidence.sealedSha256,
  });
}
