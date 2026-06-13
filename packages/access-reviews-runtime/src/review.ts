import {
  computeNextScheduledStart,
  isItemOverdue,
  shouldEscalate,
  type AccessReviewCampaign,
  type AccessReviewItem,
} from "@crossengin/access-reviews";

/** A terminal/resolved item status (no further reviewer action needed). */
const RESOLVED_STATUSES: ReadonlySet<AccessReviewItem["status"]> = new Set([
  "decided",
  "auto_revoked",
  "withdrawn",
  "deferred_to_next_campaign",
]);

export interface ItemsSummary {
  readonly total: number;
  readonly resolved: number;
  readonly pending: number;
  readonly inReview: number;
  readonly escalated: number;
  readonly overdue: number;
  /** resolved / total (1 when there are no items). */
  readonly progress: number;
}

/**
 * Summarizes a campaign's items at `now`: how many are resolved vs. still open, how
 * many are overdue (past `dueAt` and not yet resolved), and the completion fraction —
 * the "are we done, and what's late" rollup a campaign coordinator reports.
 */
export function summarizeItems(items: readonly AccessReviewItem[], now: Date): ItemsSummary {
  let resolved = 0;
  let pending = 0;
  let inReview = 0;
  let escalated = 0;
  let overdue = 0;
  for (const item of items) {
    if (RESOLVED_STATUSES.has(item.status)) resolved += 1;
    if (item.status === "pending") pending += 1;
    if (item.status === "in_review") inReview += 1;
    if (item.status === "escalated") escalated += 1;
    if (isItemOverdue(item, now)) overdue += 1;
  }
  return {
    total: items.length,
    resolved,
    pending,
    inReview,
    escalated,
    overdue,
    progress: items.length === 0 ? 1 : resolved / items.length,
  };
}

/** The items past their review deadline (not yet resolved) — what a campaign escalation pages on. */
export function overdueItems(items: readonly AccessReviewItem[], now: Date): readonly AccessReviewItem[] {
  return items.filter((item) => isItemOverdue(item, now));
}

/** The in-review items whose assigned reviewer has sat on them past the escalation timeout. */
export function itemsToEscalate(
  items: readonly AccessReviewItem[],
  now: Date,
  escalationTimeoutHours: number,
): readonly AccessReviewItem[] {
  return items.filter((item) => shouldEscalate(item, now, escalationTimeoutHours));
}

/** True when every item is resolved (the campaign can close). */
export function allItemsResolved(items: readonly AccessReviewItem[]): boolean {
  return items.every((item) => RESOLVED_STATUSES.has(item.status));
}

/**
 * The start time for the next recurring campaign after this one (the "on a schedule"
 * part) — `null` for non-recurring frequencies (one_time / ad_hoc / post_incident).
 */
export function nextCampaignStart(campaign: AccessReviewCampaign): string | null {
  return computeNextScheduledStart(campaign);
}
