import {
  type AccessReviewCampaign,
  type AccessReviewDecision,
  type AccessReviewItem,
  type AutoRevokePolicy,
  type DecisionKind,
} from "@crossengin/access-reviews";
import { unreadableDetail, type UnreadableRow } from "@crossengin/kernel-pg";

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
  /**
   * A stored row this package's mappers cannot represent.
   *
   * Three kinds and not one, because they are reported by three different reads and the sweep
   * carries on differently after each: an unreadable **campaign** is one campaign dropped from a
   * tenant's sweep, where an unreadable **item** or **decision** leaves that campaign's own graph
   * incomplete — so every cross-row finding over it (`item_campaign_mismatch`,
   * `decision_item_mismatch`, `decision_campaign_mismatch`, `auto_revoke_kind_mismatch`) becomes an
   * inference. One kind would have lost that, and `CampaignReplay.complete` is what reports it.
   *
   * These are **findings and not obstacles to finding** (ADR-0289). Before them, one row threw out
   * of a `.map` and took every other row in the read with it: a campaign with a NULL
   * `scheduled_start_at` ended the whole tenant's sweep, which reports as a clean bill of health.
   */
  "unreadable_campaign_row",
  "unreadable_item_row",
  "unreadable_decision_row",
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

/** What a finding puts where an id belongs when the identifying column is itself what is wrong. */
const UNIDENTIFIED = "<unidentified>";

/**
 * Every check here is **also** a clause of `AccessReviewCampaignSchema`, and that is why
 * `rowToCampaign` is deliberately left not parsing.
 *
 * ADR-0362 gave `rowToDecision` a `parse` where it had returned a bare literal typed as the
 * contract, and `rowToCampaign`/`rowToItem` are the two that still do — the same
 * `mapper_cannot_throw` shape, in the same file, which looks like the obvious thing to close next.
 * Measured instead of assumed, by building the row each predicate below fires on and asking the
 * schema whether it would have refused it first: **6 of this module's 10 kinds become unreachable**,
 * which is all four of this function's plus `decided_without_decision_id` and
 * `auto_revoked_without_reason`. This function would be entirely dead — exactly the fate
 * `incident-response-runtime-pg`'s `terminal_without_timestamp` suffered once `rowToIncident`
 * parsed, and that module deleted the kind for it.
 *
 * The trade is worse than a label. `counter_overflow` reads *"resolved 7 exceeds totalItems 5"*;
 * what replaces it is `unreadable_campaign_row` with `detail: "totalItems: custom"`, because zod
 * renders a `superRefine` issue as the opaque code `custom` — so the parse buys a strictly less
 * useful report for six findings and reaches no cross-row one.
 *
 * The gap it leaves is real: a clause nobody here hand-checks — a `deadlineAt` before its
 * `scheduledStartAt`, a `post_incident` campaign naming no incident, an item whose reviewer is its
 * own principal — is caught on no path. Closing it honestly means a `contract_violation` kind
 * **beside** these six rather than instead of them, which is a decision about whether one defect may
 * produce two findings.
 */
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

/**
 * One tenant's sweep: a replay per campaign that could be read, and a finding per campaign that
 * could not.
 *
 * `unreadableCampaigns` is its own field rather than a `CampaignReplay` with `found: false`, because
 * a refused row names no campaign id to replay — `found: false` means *this id has no row*, which is
 * a different fact and has a different remedy. A bare array return could carry neither.
 */
export interface TenantReplay {
  readonly tenantId: string;
  readonly replays: readonly CampaignReplay[];
  readonly unreadableCampaigns: readonly AccessReviewDriftIssue[];
}

/** One campaign's graph and every finding over it, read once. */
export interface CampaignReplay {
  readonly tenantId: string;
  readonly campaignId: string;
  readonly found: boolean;
  readonly items: number;
  readonly decisions: number;
  /**
   * Whether this replay saw the whole of the campaign's graph.
   *
   * `false` makes every **cross-row** finding an inference rather than an observation, and makes the
   * absence of one say nothing: `verifyDecisionRowShape` compares a decision against the item
   * `itemsById` holds, so a decision whose item was the unreadable row reads as having no item at
   * all, and the question is simply not asked. `items` and `decisions` are counts of what could be
   * read, which is a different quantity from what is on disk — so a clean replay with
   * `complete: false` is "nothing wrong was found in what could be read", not "nothing is wrong".
   * `IncidentReplayReport.windowComplete`'s rule for a different kind of incompleteness.
   */
  readonly complete: boolean;
  readonly issues: readonly AccessReviewDriftIssue[];
}

/**
 * The unreadable rows of a read, as findings.
 *
 * The kind is supplied by the caller rather than derived, because only the caller knows which read
 * produced them — and `UNIDENTIFIED` stands in where `identity` is `null`, which is exactly when the
 * identifying column is itself what is wrong, so inventing a handle would be worse than admitting
 * there is none (ADR-0331).
 */
function unreadableIssues(
  kind: AccessReviewDriftIssueKind,
  unreadable: readonly UnreadableRow[],
): readonly AccessReviewDriftIssue[] {
  return unreadable.map((row) => ({
    kind,
    id: row.identity ?? UNIDENTIFIED,
    detail: row.detail,
  }));
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
    let campaign: AccessReviewCampaign | null;
    try {
      campaign = await this.stores.campaignStore.getByCampaignId(tenantId, campaignId);
    } catch (err) {
      // `getByCampaignId` is a point lookup, so it refuses rather than answers — right for
      // `AccessReviewCampaignLifecycle`, which acts on the row it gets back. Here it is a finding.
      // `found` stays **true**, because a refused row is a row: *this campaign's row cannot be
      // represented* and *there is no such campaign* are different answers with different remedies,
      // and ADR-0322's rule is that a sweep must not read the first as the second.
      return {
        tenantId,
        campaignId,
        found: true,
        items: 0,
        decisions: 0,
        complete: false,
        issues: [
          {
            kind: "unreadable_campaign_row",
            // The id the *caller* asked about, never one read off a row whose columns are of
            // unestablished trustworthiness.
            id: campaignId,
            detail: unreadableDetail(err),
          },
        ],
      };
    }
    if (campaign === null) {
      return {
        tenantId,
        campaignId,
        found: false,
        items: 0,
        decisions: 0,
        complete: true,
        issues: [],
      };
    }
    // The `*WithUnreadable` siblings, because this is the verifier: the plain `listByCampaign`
    // refuses the whole read rather than hand a scheduler a short list, which is right for the
    // scheduler and would end the sweep here. See `recordsOrRefuse`.
    const items = await this.stores.itemStore.listByCampaignWithUnreadable(tenantId, campaignId);
    const decisions = await this.stores.decisionStore.listByCampaignWithUnreadable(
      tenantId,
      campaignId,
    );
    const itemsById = new Map(items.records.map((it) => [it.id, it] as const));
    const issues: AccessReviewDriftIssue[] = [
      ...unreadableIssues("unreadable_item_row", items.unreadable),
      ...unreadableIssues("unreadable_decision_row", decisions.unreadable),
      ...verifyCampaignRowShape(campaign),
    ];
    for (const item of items.records) {
      issues.push(...verifyItemRowShape(item, campaign));
    }
    for (const decision of decisions.records) {
      issues.push(
        ...verifyDecisionRowShape(decision, itemsById.get(decision.itemId), campaign),
      );
    }
    return {
      tenantId,
      campaignId,
      found: true,
      items: items.records.length,
      decisions: decisions.records.length,
      complete: items.unreadable.length === 0 && decisions.unreadable.length === 0,
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
  async replayTenant(tenantId: string): Promise<TenantReplay> {
    const campaigns = await this.stores.campaignStore.listByTenant(tenantId);
    const replays: CampaignReplay[] = [];
    for (const campaign of campaigns.records) {
      replays.push(await this.replayCampaign(tenantId, campaign.id));
    }
    return {
      tenantId,
      replays,
      unreadableCampaigns: unreadableIssues(
        "unreadable_campaign_row",
        campaigns.unreadable,
      ),
    };
  }
}
