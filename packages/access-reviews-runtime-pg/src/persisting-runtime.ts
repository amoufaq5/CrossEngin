import type {
  AccessReviewCampaign,
  AccessReviewDecision,
  AccessReviewEvidence,
  AccessReviewItem,
  PrincipalUnderReview,
} from "@crossengin/access-reviews";
import {
  AccessReviewRuntime,
  compileCampaignEvidence,
  evidenceIdFor,
  sealCompiledEvidence,
  verifyCompiledEvidenceSeal,
  type AccessReviewRuntimeOptions,
  type CompiledEvidence,
  type GenerateItemsOptions,
  type LiveGrant,
} from "@crossengin/access-reviews-runtime";
import type { PgConnection } from "@crossengin/kernel-pg";

import { PostgresAccessReviewCampaignStore } from "./campaign-store.js";
import { PostgresAccessReviewDecisionStore } from "./decision-store.js";
import { PostgresAccessReviewEvidenceStore } from "./evidence-store.js";
import { CampaignUuidResolver, ItemUuidResolver } from "./id-mapping.js";
import { PostgresAccessReviewItemStore } from "./item-store.js";

export interface PersistentAccessReviewRuntimeParts {
  readonly runtime: AccessReviewRuntime;
  readonly campaignStore: PostgresAccessReviewCampaignStore;
  readonly itemStore: PostgresAccessReviewItemStore;
  readonly decisionStore: PostgresAccessReviewDecisionStore;
  readonly evidenceStore: PostgresAccessReviewEvidenceStore;
  readonly campaignResolver: CampaignUuidResolver;
  readonly itemResolver: ItemUuidResolver;
}

/** What a campaign close did, so a caller can report it without re-reading. */
export interface CampaignCloseOutcome {
  readonly campaign: AccessReviewCampaign;
  /** The sealed pack, or `null` when `sealEvidence` was off. */
  readonly evidence: AccessReviewEvidence | null;
}

export class PersistentAccessReviewRuntime {
  readonly runtime: AccessReviewRuntime;
  readonly campaignStore: PostgresAccessReviewCampaignStore;
  readonly itemStore: PostgresAccessReviewItemStore;
  readonly decisionStore: PostgresAccessReviewDecisionStore;
  readonly evidenceStore: PostgresAccessReviewEvidenceStore;
  readonly campaignResolver: CampaignUuidResolver;
  readonly itemResolver: ItemUuidResolver;

  constructor(parts: PersistentAccessReviewRuntimeParts) {
    this.runtime = parts.runtime;
    this.campaignStore = parts.campaignStore;
    this.itemStore = parts.itemStore;
    this.decisionStore = parts.decisionStore;
    this.evidenceStore = parts.evidenceStore;
    this.campaignResolver = parts.campaignResolver;
    this.itemResolver = parts.itemResolver;
  }

  async startCampaign(
    campaign: AccessReviewCampaign,
    now?: Date,
  ): Promise<AccessReviewCampaign> {
    const started = this.runtime.startCampaign(campaign, now ?? this.runtime.clock.now());
    await this.campaignStore.upsert(started);
    return started;
  }

  async persistCampaign(campaign: AccessReviewCampaign): Promise<AccessReviewCampaign> {
    await this.campaignStore.upsert(campaign);
    return campaign;
  }

  async generateItems(
    campaign: AccessReviewCampaign,
    grants: readonly LiveGrant[],
    principals: readonly PrincipalUnderReview[],
    opts?: Pick<GenerateItemsOptions, "assignReviewers">,
  ): Promise<readonly AccessReviewItem[]> {
    await this.campaignStore.upsert(campaign);
    const items = this.runtime.generateItems(campaign, grants, principals, opts);
    for (const item of items) {
      await this.itemStore.upsert(item);
    }
    return items;
  }

  /**
   * Closes a campaign and seals its evidence pack, in that order.
   *
   * Both halves had no caller at all before this: nothing in the workspace moved a campaign to
   * `completed`, which made `planNextOccurrence` (which returns `null` for any other status) unable
   * to plan a recurrence *and* made an evidence pack — which may only cover a finished campaign —
   * impossible to compile. A quarterly review therefore started once, auto-revoked, and then sat
   * `in_progress` for ever while `access.periodic_review` scored `not_assessed`.
   *
   * The pack's **period is the campaign's own** — `startedAt`/`scheduledStartAt` to `completedAt` —
   * not a configured window, because the period an evidence pack covers is a property of the review
   * that happened rather than of a config block somebody has to keep in step with it. That is also
   * what makes the whole path need no new CLI surface.
   *
   * The seal failing does **not** undo the close: the campaign is `completed` and persisted first,
   * and the outcome reports `evidence: null` rather than throwing, which is ADR-0320's
   * `tenantRetired` rule — a close that happened and could not be attested to has happened, and a
   * raise would say otherwise. The next pass finds the campaign `completed` and can seal it then,
   * because `evidenceIdFor` derives the id from the period and so a retry is idempotent.
   */
  async closeCampaign(input: {
    readonly campaign: AccessReviewCampaign;
    /** Who compiled the pack. Must be a `meta.users` row — `created_by` is a NOT NULL user FK. */
    readonly createdBy: string;
    readonly now?: Date;
    readonly sealEvidence?: boolean;
    readonly storageUri?: string;
    readonly onSealError?: (err: unknown) => void;
  }): Promise<CampaignCloseOutcome> {
    const now = input.now ?? this.runtime.clock.now();
    const items = await this.itemStore.listByCampaign(
      input.campaign.tenantId,
      input.campaign.id,
    );
    const completed = this.runtime.completeCampaign(input.campaign, items, now);
    await this.campaignStore.upsert(completed);
    if (input.sealEvidence === false) {
      return { campaign: completed, evidence: null };
    }
    try {
      const sealed = await this.sealEvidenceForCampaign({
        campaign: completed,
        items,
        createdBy: input.createdBy,
        now,
        ...(input.storageUri !== undefined ? { storageUri: input.storageUri } : {}),
      });
      return { campaign: completed, evidence: sealed.evidence };
    } catch (err) {
      input.onSealError?.(err);
      return { campaign: completed, evidence: null };
    }
  }

  /**
   * Compiles, writes, seals and re-stamps one campaign's pack.
   *
   * Four statements and not one transaction, deliberately: `compile` and `seal` are two claims and
   * the second re-asserts the first **in its own predicate**, so a crash between them leaves a
   * `compiled` row that the next pass seals rather than a lost one. Wrapping them would buy nothing
   * the guard does not already give and would hold the connection across a digest computation.
   */
  async sealEvidenceForCampaign(input: {
    readonly campaign: AccessReviewCampaign;
    readonly items?: readonly AccessReviewItem[];
    readonly createdBy: string;
    readonly now?: Date;
    readonly storageUri?: string;
  }): Promise<CompiledEvidence> {
    const now = input.now ?? this.runtime.clock.now();
    const { campaign } = input;
    const items =
      input.items ??
      (await this.itemStore.listByCampaign(campaign.tenantId, campaign.id));
    const decisions = await this.decisionStore.listByCampaign(
      campaign.tenantId,
      campaign.id,
    );
    const compiled = compileCampaignEvidence({
      tenantId: campaign.tenantId,
      framework: campaign.framework,
      periodStartAt: campaign.startedAt ?? campaign.scheduledStartAt,
      periodEndAt: campaign.completedAt ?? now.toISOString(),
      campaigns: [campaign],
      items,
      decisions,
      createdBy: input.createdBy,
      now,
    });
    await this.evidenceStore.compile(compiled.evidence);
    const sealed = sealCompiledEvidence({
      compiled,
      now,
      ...(input.storageUri !== undefined ? { storageUri: input.storageUri } : {}),
    });
    await this.evidenceStore.seal(sealed.evidence);
    return sealed;
  }

  /**
   * Seals a finished campaign's pack if one is not sealed already, and answers what it found.
   *
   * This is the retry path `closeCampaign` needs to not be a one-shot: a close that happened and
   * could not be attested to leaves the campaign `completed` with no sealed pack, and without this
   * the next pass would see a `completed` campaign, do nothing, and leave
   * `access.periodic_review` `not_assessed` for ever — the exact silence this increment exists to
   * end, re-introduced one tick later.
   *
   * `already_sealed` is checked by **reading the row rather than remembering**, because the
   * remembering would be per-process and the deployment that needs this is the one that restarted.
   */
  async ensureSealedEvidenceForCampaign(input: {
    readonly campaign: AccessReviewCampaign;
    readonly createdBy: string;
    readonly now?: Date;
    readonly storageUri?: string;
  }): Promise<
    | { readonly outcome: "already_sealed"; readonly evidence: AccessReviewEvidence }
    | { readonly outcome: "sealed"; readonly evidence: AccessReviewEvidence }
  > {
    const { campaign } = input;
    const now = input.now ?? this.runtime.clock.now();
    const stored = await this.evidenceStore.getByEvidenceId(
      campaign.tenantId,
      evidenceIdFor({
        tenantId: campaign.tenantId,
        framework: campaign.framework,
        periodStartAt: campaign.startedAt ?? campaign.scheduledStartAt,
        periodEndAt: campaign.completedAt ?? now.toISOString(),
      }),
    );
    if (stored !== null && stored.sealedSha256 !== null) {
      return { outcome: "already_sealed", evidence: stored };
    }
    const sealed = await this.sealEvidenceForCampaign({
      campaign,
      createdBy: input.createdBy,
      now,
      ...(input.storageUri !== undefined ? { storageUri: input.storageUri } : {}),
    });
    return { outcome: "sealed", evidence: sealed.evidence };
  }

  /**
   * Checks a stored pack's seal by **re-deriving its bundle from the persisted rows**.
   *
   * This is what makes the digest load-bearing rather than decorative: nothing stores the bundle
   * bytes, so `storageUri` names the derivation and the only way to answer `verifyEvidenceSeal` is
   * to recompute it from `access_review_items` + `access_review_decisions`. The intended
   * consequence is that an item or a decision edited after the pack was sealed breaks the digest.
   *
   * `absent` is its own answer and closes nothing, for ADR-0329's reason: a pack that is not there
   * is not a pack that verifies, and it is exactly the fact a naive "no finding" check reads as
   * healthy.
   */
  async verifyStoredEvidence(input: {
    readonly campaign: AccessReviewCampaign;
    readonly createdBy: string;
    readonly now?: Date;
  }): Promise<
    | { readonly outcome: "absent" }
    | { readonly outcome: "verified"; readonly evidence: AccessReviewEvidence }
    | {
        readonly outcome: "unverified";
        readonly evidence: AccessReviewEvidence;
        readonly reason: string;
      }
  > {
    const { campaign } = input;
    const evidenceId = evidenceIdFor({
      tenantId: campaign.tenantId,
      framework: campaign.framework,
      periodStartAt: campaign.startedAt ?? campaign.scheduledStartAt,
      periodEndAt: campaign.completedAt ?? "",
    });
    const stored = await this.evidenceStore.getByEvidenceId(
      campaign.tenantId,
      evidenceId,
    );
    if (stored === null) return { outcome: "absent" };
    const items = await this.itemStore.listByCampaign(campaign.tenantId, campaign.id);
    const decisions = await this.decisionStore.listByCampaign(
      campaign.tenantId,
      campaign.id,
    );
    const recompiled = compileCampaignEvidence({
      tenantId: stored.tenantId,
      framework: stored.framework,
      periodStartAt: stored.periodStartAt,
      periodEndAt: stored.periodEndAt,
      campaigns: [campaign],
      items,
      decisions,
      createdBy: input.createdBy,
      now: input.now ?? this.runtime.clock.now(),
    });
    const result = verifyCompiledEvidenceSeal({
      evidence: stored,
      bundle: recompiled.bundle,
    });
    return result.ok
      ? { outcome: "verified", evidence: stored }
      : {
          outcome: "unverified",
          evidence: stored,
          reason: result.reason ?? "seal did not verify",
        };
  }

  async planAutoRevocations(
    items: readonly AccessReviewItem[],
    campaign: AccessReviewCampaign,
    now?: Date,
  ): Promise<readonly AccessReviewDecision[]> {
    const decisions = this.runtime.planAutoRevocations(
      items,
      campaign,
      now ?? this.runtime.clock.now(),
    );
    for (const decision of decisions) {
      await this.decisionStore.record(decision);
    }
    return decisions;
  }
}

export interface BuildPersistentAccessReviewRuntimeOptions
  extends AccessReviewRuntimeOptions {
  readonly runtime?: AccessReviewRuntime;
}

export function buildPersistentAccessReviewRuntime(
  conn: PgConnection,
  opts: BuildPersistentAccessReviewRuntimeOptions,
): PersistentAccessReviewRuntime {
  const runtime = opts.runtime ?? new AccessReviewRuntime(opts);
  const campaignResolver = new CampaignUuidResolver();
  const itemResolver = new ItemUuidResolver();
  const campaignStore = new PostgresAccessReviewCampaignStore(conn, campaignResolver);
  const itemStore = new PostgresAccessReviewItemStore(conn, campaignResolver, itemResolver);
  const decisionStore = new PostgresAccessReviewDecisionStore(
    conn,
    campaignResolver,
    itemResolver,
  );
  const evidenceStore = new PostgresAccessReviewEvidenceStore(conn);
  return new PersistentAccessReviewRuntime({
    runtime,
    campaignStore,
    itemStore,
    decisionStore,
    evidenceStore,
    campaignResolver,
    itemResolver,
  });
}
