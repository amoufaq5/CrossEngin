import {
  canTransitionItem,
  type AccessReviewCampaign,
  type AccessReviewDecision,
  type AccessReviewItem,
} from "@crossengin/access-reviews";

import type { PostgresAccessReviewCampaignStore } from "./campaign-store.js";
import type { PostgresAccessReviewDecisionStore } from "./decision-store.js";
import type { PostgresAccessReviewItemStore } from "./item-store.js";

export type DriftIssueKind =
  | "counter_overflow"
  | "completed_without_timestamp"
  | "completed_with_open_items"
  | "cancelled_without_reason"
  | "decided_without_decision_id"
  | "auto_revoked_without_reason"
  | "item_campaign_mismatch"
  | "decision_item_mismatch"
  | "decision_campaign_mismatch"
  | "auto_revoke_kind_mismatch";

export interface DriftIssue {
  readonly kind: DriftIssueKind;
  readonly id: string;
  readonly detail: string;
}

export function verifyCampaignRowShape(
  campaign: AccessReviewCampaign,
): readonly DriftIssue[] {
  const issues: DriftIssue[] = [];
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
): readonly DriftIssue[] {
  const issues: DriftIssue[] = [];
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

export function verifyDecisionRowShape(
  decision: AccessReviewDecision,
  item?: AccessReviewItem,
): readonly DriftIssue[] {
  const issues: DriftIssue[] = [];
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
  if (
    decision.reason === "no_response_auto_default" &&
    decision.kind !== "revoke" &&
    !canTransitionItem("escalated", "auto_revoked")
  ) {
    issues.push({
      kind: "auto_revoke_kind_mismatch",
      id: decision.id,
      detail: "no_response_auto_default decision is not a revoke",
    });
  }
  return issues;
}

export interface EnforcementSummary {
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

export class AccessReviewReplayer {
  constructor(private readonly stores: AccessReviewReplayerStores) {}

  async verifyCampaign(
    tenantId: string,
    campaignId: string,
  ): Promise<readonly DriftIssue[]> {
    const campaign = await this.stores.campaignStore.getByCampaignId(tenantId, campaignId);
    if (campaign === null) return [];
    const items = await this.stores.itemStore.listByCampaign(tenantId, campaignId);
    const decisions = await this.stores.decisionStore.listByCampaign(tenantId, campaignId);
    const itemsById = new Map(items.map((it) => [it.id, it] as const));
    const issues: DriftIssue[] = [...verifyCampaignRowShape(campaign)];
    for (const item of items) {
      issues.push(...verifyItemRowShape(item, campaign));
    }
    for (const decision of decisions) {
      issues.push(...verifyDecisionRowShape(decision, itemsById.get(decision.itemId)));
    }
    return issues;
  }

  async summarize(
    tenantId: string,
    campaignId: string,
  ): Promise<EnforcementSummary> {
    const campaign = await this.stores.campaignStore.getByCampaignId(tenantId, campaignId);
    const items = await this.stores.itemStore.listByCampaign(tenantId, campaignId);
    const decisions = await this.stores.decisionStore.listByCampaign(tenantId, campaignId);
    const issues = await this.verifyCampaign(tenantId, campaignId);
    return {
      campaigns: campaign === null ? 0 : 1,
      items: items.length,
      decisions: decisions.length,
      issues: issues.length,
    };
  }
}
