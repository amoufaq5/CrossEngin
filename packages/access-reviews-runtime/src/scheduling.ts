import {
  AccessReviewCampaignSchema,
  canTransitionCampaign,
  computeNextScheduledStart,
  isPastDeadline,
  isPastGracePeriod,
  type AccessReviewCampaign,
  type CampaignStatus,
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
