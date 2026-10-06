import { sha256 } from "@crossengin/crypto";
import {
  CONTROL_MAPPINGS,
  STRONG_ATTESTATION_KINDS,
  AccessReviewEvidenceSchema,
  computeCampaignEvidenceMetrics,
  isItemOverdue,
  sealEvidenceWithBundle,
  verifyEvidenceSeal,
  type AccessReviewCampaign,
  type AccessReviewDecision,
  type AccessReviewEvidence,
  type AccessReviewItem,
  type ComplianceFramework,
} from "@crossengin/access-reviews";

/**
 * The scale `meta.access_review_evidence` stores every rate at — `NUMERIC(5, 4)`.
 *
 * This constant is load-bearing rather than documentation, and the reason is the one ADR-0332
 * settled for `decimal` read back in the other direction. `computeCampaignEvidenceMetrics` divides,
 * so 2 of 3 resolved items is `0.6666666666666666`; `AccessReviewEvidenceSchema` accepts it;
 * `computeEvidenceSealSha256` **commits to it**; and the column then stores `0.6667`. Seal a pack
 * with a full-precision rate and the digest is over figures the row does not hold, so
 * `verifyEvidenceSeal` fails against the stored record from the moment it is written — an
 * unverifiable proof, which is worse than no proof because it reads as one.
 *
 * So the rates are quantised **before the digest is computed**, here in the producer, and the store
 * refuses one that is not. Quantising at the store boundary is what ADR-0332 does for a computed
 * `decimal` and is exactly wrong here: it would silently invalidate the seal the row carries.
 */
export const EVIDENCE_RATE_SCALE = 4;

const RATE_QUANTUM = 10 ** EVIDENCE_RATE_SCALE;

/** The stored spelling of a rate: `NUMERIC(5, 4)`'s value, as a JS number. */
export function quantizeEvidenceRate(rate: number): number {
  if (!Number.isFinite(rate)) {
    throw new Error(`evidence rate is not finite: ${String(rate)}`);
  }
  const clamped = Math.min(1, Math.max(0, rate));
  return Math.round(clamped * RATE_QUANTUM) / RATE_QUANTUM;
}

/** Whether a rate is already at the storage scale, so writing it cannot move it. */
export function isQuantizedEvidenceRate(rate: number): boolean {
  return Number.isFinite(rate) && quantizeEvidenceRate(rate) === rate;
}

/** The seven rate fields a `NUMERIC(5, 4)` column holds, named once so no reader can miss one. */
export const EVIDENCE_RATE_FIELDS = [
  "completionRate",
  "keepRate",
  "revokeRate",
  "autoRevokeRate",
  "exceptionRate",
  "strongAttestationRate",
  "overdueRate",
] as const satisfies readonly (keyof AccessReviewEvidence)[];

export type EvidenceRateField = (typeof EVIDENCE_RATE_FIELDS)[number];

/** Every rate field on a record that is not at the storage scale. */
export function unquantizedEvidenceRates(
  evidence: Pick<AccessReviewEvidence, EvidenceRateField>,
): readonly EvidenceRateField[] {
  return EVIDENCE_RATE_FIELDS.filter((f) => !isQuantizedEvidenceRate(evidence[f]));
}

const EVIDENCE_ID_DOMAIN = "crossengin.access-review.evidence.id.v1";
const EVIDENCE_ID_HEX_LENGTH = 24;

export interface EvidencePeriodKey {
  readonly tenantId: string;
  readonly framework: ComplianceFramework;
  readonly periodStartAt: string;
  readonly periodEndAt: string;
}

/**
 * A pack's id, derived from the **compliance period it covers** rather than minted at random.
 *
 * The period is the identity: one evidence pack per tenant per framework per period is what an
 * auditor is given, so re-compiling a period has to land on the row it already wrote rather than
 * beside it. That is what makes the store's `compile` idempotent on a retry without an idempotency
 * key, and it is what lets the pre-seal guard mean something — a second compilation of a period
 * already sealed collides with the sealed row and is refused, where a freshly minted id would
 * quietly store a second, contradictory pack for the same period.
 *
 * Derived from the period and **not** from the content, which is the opposite of
 * `meta.audit_integrity_verdicts`' `aiv_` + sha256-of-report. There the content *is* the claim and a
 * changed field must be a different row; here the content is a measurement of a period that is
 * allowed to be re-measured until it is sealed.
 */
export function evidenceIdFor(key: EvidencePeriodKey): string {
  const digest = sha256(
    [
      EVIDENCE_ID_DOMAIN,
      key.tenantId,
      key.framework,
      key.periodStartAt,
      key.periodEndAt,
    ].join("\n"),
  );
  return `arv_${digest.slice(0, EVIDENCE_ID_HEX_LENGTH)}`;
}

/* ------------------------------------------------------------------ refusals */

export const EVIDENCE_COMPILATION_REFUSALS = [
  /** No campaign was supplied for the framework and period, so there is nothing to attest to. */
  "no_campaigns",
  /** A supplied campaign is for a different framework than the pack claims. */
  "framework_mismatch",
  /** A supplied campaign belongs to a different tenant than the pack claims. */
  "tenant_mismatch",
  /**
   * A supplied campaign has not finished. A pack is a statement about a period that is over; sealing
   * one over a running review would commit a digest to figures still being written.
   */
  "campaign_unfinished",
  /** The period is empty or inverted, which `AccessReviewEvidenceSchema` also refuses. */
  "period_invalid",
  /** An item or decision belongs to a campaign outside the pack, so the figures would not add up. */
  "foreign_item",
] as const;

export type EvidenceCompilationRefusal =
  (typeof EVIDENCE_COMPILATION_REFUSALS)[number];

export class EvidenceCompilationRefusedError extends Error {
  constructor(
    readonly refusal: EvidenceCompilationRefusal,
    detail: string,
  ) {
    super(`access-review evidence compilation refused (${refusal}): ${detail}`);
    this.name = "EvidenceCompilationRefusedError";
  }
}

/**
 * The campaign statuses a pack may be compiled over.
 *
 * `completed` and `archived` only — `CAMPAIGN_TRANSITIONS.completed` is `["archived"]`, so these are
 * the two from which no decision can still arrive. `cancelled` is terminal too and deliberately
 * excluded: a cancelled campaign produced no review, and counting its items would report a
 * completion rate for a review that did not happen.
 */
export const EVIDENCE_COMPILABLE_CAMPAIGN_STATUSES: ReadonlySet<
  AccessReviewCampaign["status"]
> = new Set(["completed", "archived"]);

/* --------------------------------------------------------------- the bundle */

export interface EvidenceBundleDecisionRow {
  readonly decisionId: string;
  readonly kind: AccessReviewDecision["kind"];
  readonly reason: AccessReviewDecision["reason"];
  readonly attestationKind: AccessReviewDecision["attestation"]["kind"];
  readonly attestedByUserId: string;
  readonly coAttestingUserId: string | null;
  readonly decidedAt: string;
}

export interface EvidenceBundleItemRow {
  readonly itemId: string;
  readonly campaignId: string;
  readonly principalId: string;
  readonly principalType: AccessReviewItem["principalType"];
  readonly grantKind: AccessReviewItem["grantKind"];
  readonly grantId: string;
  readonly riskLevel: AccessReviewItem["riskLevel"];
  readonly status: AccessReviewItem["status"];
  readonly dueAt: string;
  readonly decision: EvidenceBundleDecisionRow | null;
}

export interface EvidenceBundle {
  readonly version: "crossengin.access-review.evidence.bundle.rows.v1";
  readonly tenantId: string;
  readonly framework: ComplianceFramework;
  readonly periodStartAt: string;
  readonly periodEndAt: string;
  readonly campaignIds: readonly string[];
  readonly items: readonly EvidenceBundleItemRow[];
}

/**
 * The bytes the seal digest is computed over: every reviewed item and the decision that resolved it.
 *
 * Deterministic by construction rather than by canonicalisation — every object is built here with a
 * fixed key order and both arrays are sorted by id — so `JSON.stringify` is stable whatever order
 * the rows arrived in. A test asserts that against a shuffled input, because the property is the
 * whole reason the digest means anything.
 *
 * It is **re-derivable from the persisted rows**, which is what makes the seal checkable at all:
 * nothing stores a blob, so `storageUri` names this derivation and `verifyEvidenceSeal` is answered
 * by recomputing the bundle from `access_review_items` + `access_review_decisions`. The consequence
 * is the intended one — an item or decision edited after sealing breaks the digest.
 */
export function evidenceBundleJson(bundle: EvidenceBundle): string {
  return JSON.stringify(bundle);
}

export const EVIDENCE_BUNDLE_URI_PREFIX = "crossengin+pg:access-review-bundle/v1/";

/**
 * The default `storageUri` for a pack whose bundle is re-derived rather than stored.
 *
 * It names the derivation, not a blob, and that is said in the scheme: a deployment with real object
 * storage passes its own URI and keeps the bytes. Pointing at a blob that does not exist is the one
 * thing this must not do, because `storageUri` is required for a `sealed` record and an auditor
 * reads it as where the evidence is.
 */
export function evidenceBundleUri(evidenceId: string): string {
  return `${EVIDENCE_BUNDLE_URI_PREFIX}${evidenceId}`;
}

/* ------------------------------------------------------------- compilation */

export interface CompileCampaignEvidenceInput {
  readonly tenantId: string;
  readonly framework: ComplianceFramework;
  readonly periodStartAt: string;
  readonly periodEndAt: string;
  readonly campaigns: readonly AccessReviewCampaign[];
  readonly items: readonly AccessReviewItem[];
  readonly decisions: readonly AccessReviewDecision[];
  /** Who compiled the pack. Must be a `meta.users` row — see the store's note on that gap. */
  readonly createdBy: string;
  readonly now: Date;
  /** The instant overdue-ness is measured at; defaults to the period end. */
  readonly measuredAt?: Date;
}

export interface CompiledEvidence {
  readonly evidence: AccessReviewEvidence;
  readonly bundle: EvidenceBundle;
}

function refuse(
  refusal: EvidenceCompilationRefusal,
  detail: string,
): never {
  throw new EvidenceCompilationRefusedError(refusal, detail);
}

/**
 * Composes an `AccessReviewEvidence` at status `compiled` from a finished campaign set.
 *
 * This is the producer `@crossengin/access-reviews` never had: `computeCampaignEvidenceMetrics` and
 * `sealEvidence` have existed since Phase 1 with **no caller anywhere in the workspace**, so no
 * `AccessReviewEvidence` was ever constructed outside the contracts' own tests, which is one level
 * beneath the missing store — a table with no writer because the record had no author.
 *
 * The effective decision for an item is the one the **item's own `decisionId`** names, not every
 * decision carrying its id. `AccessReviewDecision.supersedesDecisionId` exists, so a re-decided item
 * has several decisions and counting them all would report a keep *and* a revoke for one grant.
 */
export function compileCampaignEvidence(
  input: CompileCampaignEvidenceInput,
): CompiledEvidence {
  if (input.campaigns.length === 0) {
    refuse(
      "no_campaigns",
      `no campaign for ${input.framework} covers ${input.periodStartAt}..${input.periodEndAt}`,
    );
  }
  if (Date.parse(input.periodEndAt) <= Date.parse(input.periodStartAt)) {
    refuse(
      "period_invalid",
      `periodEndAt ${input.periodEndAt} is not after periodStartAt ${input.periodStartAt}`,
    );
  }
  for (const campaign of input.campaigns) {
    if (campaign.tenantId !== input.tenantId) {
      refuse(
        "tenant_mismatch",
        `campaign ${campaign.id} belongs to tenant ${campaign.tenantId}, not ${input.tenantId}`,
      );
    }
    if (campaign.framework !== input.framework) {
      refuse(
        "framework_mismatch",
        `campaign ${campaign.id} is a ${campaign.framework} review, not ${input.framework}`,
      );
    }
    if (!EVIDENCE_COMPILABLE_CAMPAIGN_STATUSES.has(campaign.status)) {
      refuse(
        "campaign_unfinished",
        `campaign ${campaign.id} is ${campaign.status}; a pack may only cover ` +
          `${[...EVIDENCE_COMPILABLE_CAMPAIGN_STATUSES].join(" or ")}`,
      );
    }
  }

  const campaignIds = [...input.campaigns.map((c) => c.id)].sort();
  const campaignIdSet = new Set(campaignIds);
  for (const item of input.items) {
    if (!campaignIdSet.has(item.campaignId)) {
      refuse(
        "foreign_item",
        `item ${item.id} belongs to campaign ${item.campaignId}, which is not in the pack`,
      );
    }
  }

  const decisionsById = new Map(input.decisions.map((d) => [d.id, d]));
  const measuredAt = input.measuredAt ?? new Date(Date.parse(input.periodEndAt));

  let decidedItems = 0;
  let autoRevokedItems = 0;
  let exceptionItems = 0;
  let keepDecisions = 0;
  let revokeDecisions = 0;
  let extendDecisions = 0;
  let modifyDecisions = 0;
  let deferDecisions = 0;
  let strongAttestationCount = 0;
  let overdueAtCompletion = 0;
  const rows: EvidenceBundleItemRow[] = [];

  for (const item of input.items) {
    if (item.status === "decided") decidedItems += 1;
    if (item.status === "auto_revoked") autoRevokedItems += 1;
    if (item.status === "exception_pending") exceptionItems += 1;
    if (isItemOverdue(item, measuredAt)) overdueAtCompletion += 1;

    const effective =
      item.decisionId === null ? null : (decisionsById.get(item.decisionId) ?? null);
    if (effective !== null) {
      if (effective.kind === "keep") keepDecisions += 1;
      if (effective.kind === "revoke") revokeDecisions += 1;
      if (effective.kind === "time_bound_extend") extendDecisions += 1;
      if (effective.kind === "modify_grant") modifyDecisions += 1;
      if (effective.kind === "defer_to_next_campaign") deferDecisions += 1;
      if (STRONG_ATTESTATION_KINDS.has(effective.attestation.kind)) {
        strongAttestationCount += 1;
      }
    }

    rows.push({
      itemId: item.id,
      campaignId: item.campaignId,
      principalId: item.principalId,
      principalType: item.principalType,
      grantKind: item.grantKind,
      grantId: item.grantId,
      riskLevel: item.riskLevel,
      status: item.status,
      dueAt: item.dueAt,
      decision:
        effective === null
          ? null
          : {
              decisionId: effective.id,
              kind: effective.kind,
              reason: effective.reason,
              attestationKind: effective.attestation.kind,
              attestedByUserId: effective.attestation.attestedByUserId,
              coAttestingUserId: effective.attestation.coAttestingUserId,
              decidedAt: effective.decidedAt,
            },
    });
  }

  rows.sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

  const metrics = computeCampaignEvidenceMetrics({
    totalItems: input.items.length,
    decidedItems,
    keepDecisions,
    revokeDecisions,
    extendDecisions,
    modifyDecisions,
    deferDecisions,
    autoRevokedItems,
    exceptionItems,
    // `meta.access_review_exceptions` has no store (ADR-0334), so an approved exception cannot be
    // read back. Harmless today only because `computeCampaignEvidenceMetrics` does not read this
    // input at all — see the note in the ADR; a rate that did would be understated.
    approvedExceptionItems: 0,
    strongAttestationCount,
    overdueAtCompletion,
  });

  const evidenceId = evidenceIdFor({
    tenantId: input.tenantId,
    framework: input.framework,
    periodStartAt: input.periodStartAt,
    periodEndAt: input.periodEndAt,
  });

  const bundle: EvidenceBundle = {
    version: "crossengin.access-review.evidence.bundle.rows.v1",
    tenantId: input.tenantId,
    framework: input.framework,
    periodStartAt: input.periodStartAt,
    periodEndAt: input.periodEndAt,
    campaignIds,
    items: rows,
  };

  const evidence = AccessReviewEvidenceSchema.parse({
    id: evidenceId,
    tenantId: input.tenantId,
    framework: input.framework,
    periodStartAt: input.periodStartAt,
    periodEndAt: input.periodEndAt,
    campaignIds,
    controlMappings: [...(CONTROL_MAPPINGS[input.framework] ?? [])],
    totalItemsAcrossCampaigns: input.items.length,
    completionRate: quantizeEvidenceRate(metrics.completionRate),
    keepRate: quantizeEvidenceRate(metrics.keepRate),
    revokeRate: quantizeEvidenceRate(metrics.revokeRate),
    autoRevokeRate: quantizeEvidenceRate(metrics.autoRevokeRate),
    exceptionRate: quantizeEvidenceRate(metrics.exceptionRate),
    strongAttestationRate: quantizeEvidenceRate(metrics.strongAttestationRate),
    overdueRate: quantizeEvidenceRate(metrics.overdueRate),
    status: "compiled",
    compiledAt: input.now.toISOString(),
    sealedAt: null,
    sealedSha256: null,
    submittedAt: null,
    submittedToAuditorId: null,
    acceptedAt: null,
    rejectedAt: null,
    rejectedReason: null,
    storageUri: null,
    createdBy: input.createdBy,
    createdAt: input.now.toISOString(),
  });

  return { evidence, bundle };
}

export interface SealCompiledEvidenceInput {
  readonly compiled: CompiledEvidence;
  readonly now: Date;
  /** Where the bundle bytes live. Defaults to the re-derivation reference. */
  readonly storageUri?: string;
}

/**
 * Seals a compiled pack over its own bundle.
 *
 * Thin on purpose: the digest is `@crossengin/access-reviews`' and is computed **here, once**, so
 * nothing downstream recomputes it from a stored column — which is ADR-0323's defect, and the reason
 * the store writes `sealedSha256` verbatim and never derives it.
 */
export function sealCompiledEvidence(
  input: SealCompiledEvidenceInput,
): CompiledEvidence {
  const { compiled } = input;
  const storageUri =
    input.storageUri ?? evidenceBundleUri(compiled.evidence.id);
  const sealed = sealEvidenceWithBundle({
    evidence: compiled.evidence,
    bundleBytes: evidenceBundleJson(compiled.bundle),
    storageUri,
    now: input.now,
  });
  return { evidence: sealed, bundle: compiled.bundle };
}

/** `verifyEvidenceSeal` against a bundle re-derived from the persisted rows. */
export function verifyCompiledEvidenceSeal(
  compiled: CompiledEvidence,
): { readonly ok: boolean; readonly reason: string | null } {
  return verifyEvidenceSeal({
    evidence: compiled.evidence,
    bundleBytes: evidenceBundleJson(compiled.bundle),
  });
}
