import {
  AccessReviewCampaignSchema,
  canTransitionCampaign,
  computeNextScheduledStart,
  isPastDeadline,
  isPastGracePeriod,
  type AccessReviewCampaign,
  type AccessReviewItem,
  type CampaignStatus,
  type ReviewItemStatus,
} from "@crossengin/access-reviews";
import type { IdGenerator } from "./clock.js";

export const STARTABLE_CAMPAIGN_STATUSES: ReadonlySet<CampaignStatus> = new Set([
  "scheduled",
]);

export const TERMINAL_CAMPAIGN_STATUSES: ReadonlySet<CampaignStatus> = new Set([
  "completed",
  "archived",
  "cancelled",
]);

const startsAtOrBefore = (
  campaign: AccessReviewCampaign,
  now: Date,
): boolean => Date.parse(campaign.scheduledStartAt) <= now.getTime();

export const isDueToStart = (
  campaign: AccessReviewCampaign,
  now: Date,
): boolean =>
  STARTABLE_CAMPAIGN_STATUSES.has(campaign.status) && startsAtOrBefore(campaign, now);

export const dueCampaigns = (
  campaigns: readonly AccessReviewCampaign[],
  now: Date,
): readonly AccessReviewCampaign[] =>
  campaigns.filter((campaign) => isDueToStart(campaign, now));

export const startCampaign = (
  campaign: AccessReviewCampaign,
  now: Date,
): AccessReviewCampaign => {
  if (!canTransitionCampaign(campaign.status, "in_progress")) {
    throw new Error(
      `cannot start campaign ${campaign.id}: ${campaign.status} -> in_progress is not a valid transition`,
    );
  }
  return AccessReviewCampaignSchema.parse({
    ...campaign,
    status: "in_progress",
    startedAt: campaign.startedAt ?? now.toISOString(),
  });
};

/**
 * The item statuses from which no further attestation is expected.
 *
 * The same four `isItemOverdue` stops counting, and deliberately the same four: an item that cannot
 * be overdue is an item nobody is still waiting on, so one definition serves both questions.
 * `escalated` and `exception_pending` are **not** here — an escalation is still owed a decision, and
 * an exception is owed an approval.
 */
export const RESOLVED_ITEM_STATUSES: ReadonlySet<ReviewItemStatus> = new Set([
  "decided",
  "auto_revoked",
  "withdrawn",
  "deferred_to_next_campaign",
]);

export const unresolvedItems = (
  items: readonly AccessReviewItem[],
): readonly AccessReviewItem[] =>
  items.filter((item) => !RESOLVED_ITEM_STATUSES.has(item.status));

/**
 * Whether a running campaign has nothing left to wait for.
 *
 * This existed nowhere, and its absence was load-bearing twice over: nothing in the workspace moved
 * a campaign to `completed`, so `planNextOccurrence` — which returns `null` for any status but
 * `completed` — could never plan a recurrence, and an evidence pack, which may only cover a finished
 * campaign, could never be compiled. A recurring quarterly review therefore ran exactly once and
 * attested to nothing.
 */
export const isCampaignCompletable = (
  campaign: AccessReviewCampaign,
  items: readonly AccessReviewItem[],
): boolean =>
  canTransitionCampaign(campaign.status, "completed") &&
  unresolvedItems(items).length === 0;

/**
 * Moves a campaign to `completed`, stamping `completedAt`.
 *
 * Refuses on the transition map rather than on a status list, and refuses an unresolved item by
 * name: completing a review with an item still awaiting a decision would make that item's absence
 * part of a sealed compliance figure, which is the one thing an auto-revocation exists to prevent.
 */
export const completeCampaign = (
  campaign: AccessReviewCampaign,
  items: readonly AccessReviewItem[],
  now: Date,
): AccessReviewCampaign => {
  if (!canTransitionCampaign(campaign.status, "completed")) {
    throw new Error(
      `cannot complete campaign ${campaign.id}: ${campaign.status} -> completed is not a valid transition`,
    );
  }
  const outstanding = unresolvedItems(items);
  if (outstanding.length > 0) {
    throw new Error(
      `cannot complete campaign ${campaign.id}: ${String(outstanding.length)} item(s) unresolved ` +
        `(${outstanding
          .slice(0, 3)
          .map((i) => `${i.id}=${i.status}`)
          .join(", ")})`,
    );
  }
  return AccessReviewCampaignSchema.parse({
    ...campaign,
    status: "completed",
    completedAt: campaign.completedAt ?? now.toISOString(),
    totalItems: items.length,
    decidedItems: items.filter((i) => i.status === "decided").length,
    autoRevokedItems: items.filter((i) => i.status === "auto_revoked").length,
    exceptionItems: items.filter((i) => i.status === "exception_pending").length,
  });
};

export const isCampaignOverdue = (
  campaign: AccessReviewCampaign,
  now: Date,
): boolean =>
  !TERMINAL_CAMPAIGN_STATUSES.has(campaign.status) && isPastDeadline(campaign, now);

export const isCampaignPastGrace = (
  campaign: AccessReviewCampaign,
  now: Date,
): boolean =>
  !TERMINAL_CAMPAIGN_STATUSES.has(campaign.status) && isPastGracePeriod(campaign, now);

export const overdueCampaigns = (
  campaigns: readonly AccessReviewCampaign[],
  now: Date,
): readonly AccessReviewCampaign[] =>
  campaigns.filter((campaign) => isCampaignOverdue(campaign, now));

export const pastGraceCampaigns = (
  campaigns: readonly AccessReviewCampaign[],
  now: Date,
): readonly AccessReviewCampaign[] =>
  campaigns.filter((campaign) => isCampaignPastGrace(campaign, now));

export const planNextOccurrence = (
  campaign: AccessReviewCampaign,
  now: Date,
  ids: IdGenerator,
): AccessReviewCampaign | null => {
  if (campaign.status !== "completed") return null;
  const nextStart = computeNextScheduledStart(campaign);
  if (nextStart === null) return null;
  const durationMs =
    Date.parse(campaign.deadlineAt) - Date.parse(campaign.scheduledStartAt);
  const nextDeadline = new Date(Date.parse(nextStart) + durationMs).toISOString();
  const nowIso = now.toISOString();
  return AccessReviewCampaignSchema.parse({
    ...campaign,
    id: ids.next("arc"),
    status: "scheduled",
    scheduledStartAt: nextStart,
    deadlineAt: nextDeadline,
    remediationDeadlineAt: null,
    createdAt: nowIso,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    cancelledAt: null,
    cancelledReason: null,
    totalItems: 0,
    decidedItems: 0,
    autoRevokedItems: 0,
    exceptionItems: 0,
  });
};
