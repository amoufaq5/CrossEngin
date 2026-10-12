import {
  type AccessReviewCampaign,
  type AccessReviewDecision,
  type AccessReviewItem,
  type AutoRevokePolicy,
  type DecisionKind,
} from "@crossengin/access-reviews";

import type { PostgresAccessReviewCampaignStore } from "./campaign-store.js";
import type { PostgresAccessReviewDecisionStore } from "./decision-store.js";
import type { PostgresAccessReviewItemStore } from "./item-store.js";

/**
 * Every kind this module can report, as a value rather than a type alone.
 *
 * It was a bare union, so nothing could iterate it, assert against it, or notice that one member
 * was unreachable — which one was. `DR_DRIFT_ISSUE_KINDS` and the SLO replayer's
 * `DRIFT_ISSUE_KINDS` are already exported consts; a findings vocabulary that is not a value cannot
 * be checked against anything.
 */
export const ACCESS_REVIEW_DRIFT_ISSUE_KINDS = [
  "counter_overflow",
  "completed_without_timestamp",
  "completed_with_open_items",
  "cancelled_without_reason",
  "decided_without_decision_id",
  "auto_revoked_without_reason",
  "item_campaign_mismatch",
  "decision_item_mismatch",
  "decision_campaign_mismatch",
  "auto_revoke_kind_mismatch",
] as const;

export type AccessReviewDriftIssueKind = (typeof ACCESS_REVIEW_DRIFT_ISSUE_KINDS)[number];

export interface AccessReviewDriftIssue {
  readonly kind: AccessReviewDriftIssueKind;
  readonly id: string;
  readonly detail: string;
}

export function verifyCampaignRowShape(
  campaign: AccessReviewCampaign,
): readonly AccessReviewDriftIssue[] {
  const issues: AccessReviewDriftIssue[] = [];
  const resolved =
    campaign.decidedItems + campaign.autoRevokedItems + campaign.exceptionItems;
  if (resolved > campaign.totalItems) {
    issues.push({
      kind: "counter_overflow",
      id: campaign.id,
      detail: `resolved ${resolved} exceeds totalItems ${campaign.totalItems}`,
    });
  }
  if (campaign.status === "completed" && campaign.completedAt === null) {
    issues.push({
      kind: "completed_without_timestamp",
      id: campaign.id,
      detail: "completed campaign has no completedAt",
    });
  }
  if (campaign.status === "completed" && resolved < campaign.totalItems) {
    issues.push({
      kind: "completed_with_open_items",
      id: campaign.id,
      detail: `completed campaign has ${campaign.totalItems - resolved} unresolved items`,
    });
  }
  if (campaign.status === "cancelled" && campaign.cancelledReason === null) {
    issues.push({
      kind: "cancelled_without_reason",
      id: campaign.id,
      detail: "cancelled campaign has no cancelledReason",
    });
  }
  return issues;
}

export function verifyItemRowShape(
  item: AccessReviewItem,
  campaign?: AccessReviewCampaign,
): readonly AccessReviewDriftIssue[] {
  const issues: AccessReviewDriftIssue[] = [];
  if (item.status === "decided" && item.decisionId === null) {
    issues.push({
      kind: "decided_without_decision_id",
      id: item.id,
      detail: "decided item has no decisionId",
    });
  }
  if (item.status === "auto_revoked" && item.autoRevokeReason === null) {
    issues.push({
      kind: "auto_revoked_without_reason",
      id: item.id,
      detail: "auto_revoked item has no autoRevokeReason",
    });
  }
  if (campaign !== undefined && item.campaignId !== campaign.id) {
    issues.push({
      kind: "item_campaign_mismatch",
      id: item.id,
      detail: `item campaignId ${item.campaignId} != campaign ${campaign.id}`,
    });
  }
  return issues;
}

/**
 * What a `no_response_auto_default` decision must be, per the campaign policy that produced it.
 *
 * A **total map** over `AUTO_REVOKE_POLICIES`, so a fifth policy is a compile error rather than a
 * member inheriting whichever branch an `if`-chain ended on.
 *
 * `escalate_to_manager` is `null` and that is the load-bearing entry: under it a no-response is
 * handed to a manager who then decides either way, so there is no kind to expect and claiming one
 * would report every escalated decision as drift. `default_keep` is the entry that makes the whole
 * check necessary — a no-response default under it is legitimately a **keep**, which is why
 * "no_response_auto_default implies revoke" is false as a standalone rule and why this question
 * cannot be answered from a decision alone.
 */
const NO_RESPONSE_DEFAULT_KIND: Readonly<Record<AutoRevokePolicy, DecisionKind | null>> =
  Object.freeze({
    auto_revoke_on_deadline: "revoke",
    default_revoke: "revoke",
    default_keep: "keep",
    escalate_to_manager: null,
  });

/**
 * `campaign` is how `auto_revoke_kind_mismatch` became reachable.
 *
 * The check read `reason === "no_response_auto_default" && kind !== "revoke" &&
 * !canTransitionItem("escalated", "auto_revoked")`, and the third conjunct depends on nothing in the
 * decision: `REVIEW_ITEM_TRANSITIONS.escalated` contains `"auto_revoked"`, so it is the constant
 * `false` and the finding **could not be emitted in any deployment**. Its own test never asserted it
 * fires, so nothing noticed.
 *
 * Deleting the kind was the other option and is the wrong one, because the premise it was reaching
 * for is real — a no-response default that disagrees with the policy that produced it is exactly the
 * kind of row an auditor asks about. What was missing is the campaign: the expected kind is a
 * property of `autoRevokePolicy`, which lives on the campaign and not on the decision. So the
 * conjunct is gone and the campaign is in, and with no campaign the question is simply **not asked**
 * rather than answered with a constant.
 */
export function verifyDecisionRowShape(
  decision: AccessReviewDecision,
  item?: AccessReviewItem,
  campaign?: AccessReviewCampaign,
): readonly AccessReviewDriftIssue[] {
  const issues: AccessReviewDriftIssue[] = [];
  if (item !== undefined) {
    if (decision.itemId !== item.id) {
      issues.push({
        kind: "decision_item_mismatch",
        id: decision.id,
        detail: `decision itemId ${decision.itemId} != item ${item.id}`,
      });
    }
    if (decision.campaignId !== item.campaignId) {
      issues.push({
        kind: "decision_campaign_mismatch",
        id: decision.id,
        detail: `decision campaignId ${decision.campaignId} != item campaign ${item.campaignId}`,
      });
    }
  }
  if (campaign !== undefined && decision.reason === "no_response_auto_default") {
    const expected = NO_RESPONSE_DEFAULT_KIND[campaign.autoRevokePolicy];
    if (expected !== null && decision.kind !== expected) {
      issues.push({
        kind: "auto_revoke_kind_mismatch",
        id: decision.id,
        detail:
          `no_response_auto_default decision is '${decision.kind}' but campaign policy ` +
          `'${campaign.autoRevokePolicy}' defaults to '${expected}'`,
      });
    }
  }
  return issues;
}

export interface AccessReviewCampaignSummary {
  readonly campaigns: number;
  readonly items: number;
  readonly decisions: number;
  readonly issues: number;
}

export interface AccessReviewReplayerStores {
  readonly campaignStore: PostgresAccessReviewCampaignStore;
  readonly itemStore: PostgresAccessReviewItemStore;
  readonly decisionStore: PostgresAccessReviewDecisionStore;
}

/** One campaign's graph and every finding over it, read once. */
export interface CampaignReplay {
  readonly tenantId: string;
  readonly campaignId: string;
  readonly found: boolean;
  readonly items: number;
  readonly decisions: number;
  readonly issues: readonly AccessReviewDriftIssue[];
}

/**
 * A per-campaign, per-tenant diagnostic, and it can be nothing else.
 *
 * All three tables declare `tenant_id NOT NULL` with the isolation policy as their only arm — no
 * platform `SELECT` arm — so as a non-owner with no tenant context a read here matches **zero**
 * rows. There is no "every scope" mode to offer and no honest way to add one: a cross-tenant sweep
 * of access reviews is a loop over `meta.tenants` setting context per tenant, which is a deployment
 * concern and not something this class can fake from one connection. `tenantId` is therefore a
 * required first argument on every method, with no default.
 */
export class AccessReviewReplayer {
  constructor(private readonly stores: AccessReviewReplayerStores) {}

  /**
   * The whole graph in three reads, which is also what `summarize` needs.
   *
   * `verifyCampaign` and `summarize` used to issue **six** statements between them for one answer,
   * because `summarize` read all three tables and then called `verifyCampaign`, which read them
   * again — so an operator sweeping a tenant's campaigns paid double, and the two halves of one
   * reported summary came from two different reads of a table that can change between them.
   */
  async replayCampaign(tenantId: string, campaignId: string): Promise<CampaignReplay> {
    const campaign = await this.stores.campaignStore.getByCampaignId(tenantId, campaignId);
    if (campaign === null) {
      return { tenantId, campaignId, found: false, items: 0, decisions: 0, issues: [] };
    }
    const items = await this.stores.itemStore.listByCampaign(tenantId, campaignId);
    const decisions = await this.stores.decisionStore.listByCampaign(tenantId, campaignId);
    const itemsById = new Map(items.map((it) => [it.id, it] as const));
    const issues: AccessReviewDriftIssue[] = [...verifyCampaignRowShape(campaign)];
    for (const item of items) {
      issues.push(...verifyItemRowShape(item, campaign));
    }
    for (const decision of decisions) {
      issues.push(
        ...verifyDecisionRowShape(decision, itemsById.get(decision.itemId), campaign),
      );
    }
    return {
      tenantId,
      campaignId,
      found: true,
      items: items.length,
      decisions: decisions.length,
      issues,
    };
  }

  async verifyCampaign(
    tenantId: string,
    campaignId: string,
  ): Promise<readonly AccessReviewDriftIssue[]> {
    return (await this.replayCampaign(tenantId, campaignId)).issues;
  }

  async summarize(
    tenantId: string,
    campaignId: string,
  ): Promise<AccessReviewCampaignSummary> {
    const replay = await this.replayCampaign(tenantId, campaignId);
    return {
      campaigns: replay.found ? 1 : 0,
      items: replay.items,
      decisions: replay.decisions,
      issues: replay.issues.length,
    };
  }

  /**
   * Every campaign in one tenant, which is the complete answer for that tenant and the unit a
   * cross-tenant loop composes from.
   *
   * `verifyCampaign` needs a campaign id the caller does not necessarily have; without this, the
   * only way to replay a tenant was to list its campaigns through a store the caller also holds,
   * which is the step a sweep would otherwise have to reinvent.
   */
  async replayTenant(tenantId: string): Promise<readonly CampaignReplay[]> {
    const campaigns = await this.stores.campaignStore.listByTenant(tenantId);
    const replays: CampaignReplay[] = [];
    for (const campaign of campaigns) {
      replays.push(await this.replayCampaign(tenantId, campaign.id));
    }
    return replays;
  }
}
