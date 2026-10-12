import { describe, expect, it } from "vitest";
import { AccessReviewCampaignSchema } from "@crossengin/access-reviews";
import { CountingIdGenerator } from "./clock.js";
import {
  RESOLVED_ITEM_STATUSES,
  STARTABLE_CAMPAIGN_STATUSES,
  TERMINAL_CAMPAIGN_STATUSES,
  completeCampaign,
  isCampaignCompletable,
  unresolvedItems,
  dueCampaigns,
  isCampaignOverdue,
  isCampaignPastGrace,
  isDueToStart,
  overdueCampaigns,
  pastGraceCampaigns,
  planNextOccurrence,
  startCampaign,
} from "./scheduling.js";
import { makeCampaign, makeItem, UUID } from "./fixtures.js";

const AFTER_START = new Date("2026-01-02T00:00:00.000Z");
const BEFORE_START = new Date("2025-12-30T00:00:00.000Z");
const AFTER_DEADLINE = new Date("2026-01-16T00:00:00.000Z");
const AFTER_GRACE = new Date("2026-01-16T06:00:00.000Z");

describe("constants", () => {
  it("marks only scheduled as startable", () => {
    expect(STARTABLE_CAMPAIGN_STATUSES.has("scheduled")).toBe(true);
    expect(STARTABLE_CAMPAIGN_STATUSES.has("draft")).toBe(false);
    expect(STARTABLE_CAMPAIGN_STATUSES.has("in_progress")).toBe(false);
  });

  it("marks completed/archived/cancelled as terminal", () => {
    expect(TERMINAL_CAMPAIGN_STATUSES.has("completed")).toBe(true);
    expect(TERMINAL_CAMPAIGN_STATUSES.has("archived")).toBe(true);
    expect(TERMINAL_CAMPAIGN_STATUSES.has("cancelled")).toBe(true);
    expect(TERMINAL_CAMPAIGN_STATUSES.has("in_progress")).toBe(false);
  });
});

describe("isDueToStart / dueCampaigns", () => {
  it("is due once the scheduled start has passed and status is scheduled", () => {
    const c = makeCampaign();
    expect(isDueToStart(c, AFTER_START)).toBe(true);
  });

  it("is not due before the scheduled start", () => {
    const c = makeCampaign();
    expect(isDueToStart(c, BEFORE_START)).toBe(false);
  });

  it("is not due when the status is draft", () => {
    const c = makeCampaign({ status: "draft" });
    expect(isDueToStart(c, AFTER_START)).toBe(false);
  });

  it("is not due when already in_progress", () => {
    const c = makeCampaign({
      status: "in_progress",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(isDueToStart(c, AFTER_START)).toBe(false);
  });

  it("filters a mixed set to only the due ones", () => {
    const due = makeCampaign({ id: "arc_00000010" });
    const early = makeCampaign({
      id: "arc_00000011",
      scheduledStartAt: "2026-02-01T00:00:00.000Z",
      deadlineAt: "2026-02-15T00:00:00.000Z",
    });
    const drafted = makeCampaign({ id: "arc_00000012", status: "draft" });
    const result = dueCampaigns([due, early, drafted], AFTER_START);
    expect(result.map((c) => c.id)).toEqual(["arc_00000010"]);
  });
});

describe("startCampaign", () => {
  it("transitions scheduled -> in_progress and stamps startedAt", () => {
    const c = makeCampaign();
    const started = startCampaign(c, AFTER_START);
    expect(started.status).toBe("in_progress");
    expect(started.startedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("preserves an existing startedAt", () => {
    const c = makeCampaign({ startedAt: "2026-01-01T12:00:00.000Z" });
    const started = startCampaign(c, AFTER_START);
    expect(started.startedAt).toBe("2026-01-01T12:00:00.000Z");
  });

  it("rejects starting a draft campaign", () => {
    const c = makeCampaign({ status: "draft" });
    expect(() => startCampaign(c, AFTER_START)).toThrow(/not a valid transition/);
  });

  it("produces a schema-valid campaign", () => {
    const started = startCampaign(makeCampaign(), AFTER_START);
    expect(() => AccessReviewCampaignSchema.parse(started)).not.toThrow();
  });
});

describe("overdue detection", () => {
  it("flags a campaign past its deadline", () => {
    const c = makeCampaign({ status: "in_progress" });
    expect(isCampaignOverdue(c, AFTER_DEADLINE)).toBe(true);
    expect(isCampaignOverdue(c, AFTER_START)).toBe(false);
  });

  it("does not flag terminal campaigns as overdue", () => {
    const c = makeCampaign({
      status: "cancelled",
      cancelledReason: "n/a",
      cancelledAt: "2026-01-05T00:00:00.000Z",
    });
    expect(isCampaignOverdue(c, AFTER_DEADLINE)).toBe(false);
  });

  it("flags past-grace only after the grace window elapses", () => {
    const c = makeCampaign({ status: "in_progress" });
    expect(isCampaignPastGrace(c, AFTER_DEADLINE)).toBe(false);
    expect(isCampaignPastGrace(c, AFTER_GRACE)).toBe(true);
  });

  it("filters overdue and past-grace campaigns", () => {
    const overdue = makeCampaign({ id: "arc_00000020", status: "in_progress" });
    const fresh = makeCampaign({
      id: "arc_00000021",
      status: "in_progress",
      scheduledStartAt: "2026-01-10T00:00:00.000Z",
      deadlineAt: "2026-02-10T00:00:00.000Z",
    });
    expect(overdueCampaigns([overdue, fresh], AFTER_DEADLINE).map((c) => c.id)).toEqual([
      "arc_00000020",
    ]);
    expect(pastGraceCampaigns([overdue, fresh], AFTER_GRACE).map((c) => c.id)).toEqual([
      "arc_00000020",
    ]);
  });
});

describe("planNextOccurrence", () => {
  const ids = new CountingIdGenerator(100);

  it("produces the next recurring instance for a completed campaign", () => {
    const completed = makeCampaign({
      status: "completed",
      completedAt: "2026-01-14T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      totalItems: 0,
    });
    const next = planNextOccurrence(completed, AFTER_DEADLINE, ids);
    expect(next).not.toBeNull();
    expect(next?.status).toBe("scheduled");
    expect(next?.id).toMatch(/^arc_/);
    expect(next?.id).not.toBe(completed.id);
    expect(next?.startedAt).toBeNull();
    expect(next?.completedAt).toBeNull();
    expect(next?.totalItems).toBe(0);
    // 91-day quarterly step from the prior scheduled start
    expect(next?.scheduledStartAt).toBe(
      new Date(Date.parse("2026-01-01T00:00:00.000Z") + 91 * 86_400_000).toISOString(),
    );
    // deadline keeps the same 14-day window
    const span =
      Date.parse(next?.deadlineAt as string) -
      Date.parse(next?.scheduledStartAt as string);
    expect(span).toBe(14 * 86_400_000);
    expect(() => AccessReviewCampaignSchema.parse(next)).not.toThrow();
  });

  it("returns null for a campaign that is not completed", () => {
    const c = makeCampaign({ status: "in_progress" });
    expect(planNextOccurrence(c, AFTER_DEADLINE, ids)).toBeNull();
  });

  it("returns null for one_time frequency", () => {
    const c = makeCampaign({
      status: "completed",
      completedAt: "2026-01-14T00:00:00.000Z",
      frequency: "one_time",
    });
    expect(planNextOccurrence(c, AFTER_DEADLINE, ids)).toBeNull();
  });

  it("returns null for ad_hoc frequency", () => {
    const c = makeCampaign({
      status: "completed",
      completedAt: "2026-01-14T00:00:00.000Z",
      frequency: "ad_hoc",
    });
    expect(planNextOccurrence(c, AFTER_DEADLINE, ids)).toBeNull();
  });
});

describe("completeCampaign", () => {
  const NOW = new Date("2026-01-20T00:00:00.000Z");
  const running = () =>
    makeCampaign({ status: "in_progress", startedAt: "2026-01-01T00:00:00.000Z" });
  const reviewerState = {
    reviewerUserId: UUID.reviewer,
    reviewerKind: "human_user" as const,
    assignedAt: "2026-01-05T00:00:00.000Z",
    reminderCount: 0,
    lastReminderAt: null,
    escalationLevel: 0,
  };
  const resolved = (id: string) =>
    makeItem({ id, status: "decided", decisionId: "ard_aaaaaaaa", decidedAt: "2026-01-09T00:00:00.000Z" });

  it("names the four statuses nobody is still waiting on", () => {
    expect([...RESOLVED_ITEM_STATUSES].sort()).toEqual([
      "auto_revoked",
      "decided",
      "deferred_to_next_campaign",
      "withdrawn",
    ]);
  });

  it("treats escalated and exception_pending as unresolved", () => {
    expect(RESOLVED_ITEM_STATUSES.has("escalated")).toBe(false);
    expect(RESOLVED_ITEM_STATUSES.has("exception_pending")).toBe(false);
  });

  it("completes a campaign whose items are all resolved", () => {
    const done = completeCampaign(running(), [resolved("ari_00000001")], NOW);
    expect(done.status).toBe("completed");
    expect(done.completedAt).toBe(NOW.toISOString());
  });

  it("completes a campaign with no items at all", () => {
    expect(completeCampaign(running(), [], NOW).status).toBe("completed");
  });

  it("stamps the item counts from the items it was handed", () => {
    const done = completeCampaign(
      running(),
      [
        resolved("ari_00000001"),
        makeItem({ id: "ari_00000002", status: "auto_revoked", autoRevokedAt: "2026-01-11T00:00:00.000Z", autoRevokeReason: "no_reviewer_response" }),
      ],
      NOW,
    );
    expect(done.totalItems).toBe(2);
    expect(done.decidedItems).toBe(1);
    expect(done.autoRevokedItems).toBe(1);
  });

  it("keeps an already-stamped completedAt rather than moving it", () => {
    const already = makeCampaign({
      status: "in_remediation",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-15T00:00:00.000Z",
    });
    expect(completeCampaign(already, [], NOW).completedAt).toBe("2026-01-15T00:00:00.000Z");
  });

  it("completes from in_remediation, which the transition map permits", () => {
    const remediating = makeCampaign({
      status: "in_remediation",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(completeCampaign(remediating, [], NOW).status).toBe("completed");
  });

  it("refuses an unresolved item by name", () => {
    expect(() =>
      completeCampaign(running(), [makeItem({ id: "ari_00000009", status: "in_review", openedForReviewAt: "2026-01-05T00:00:00.000Z", currentReviewer: reviewerState })], NOW),
    ).toThrow(/unresolved/);
  });

  it("refuses a status the transition map forbids", () => {
    expect(() => completeCampaign(makeCampaign({ status: "scheduled" }), [], NOW)).toThrow(
      /not a valid transition/,
    );
    expect(() =>
      completeCampaign(makeCampaign({ status: "completed", completedAt: "2026-01-15T00:00:00.000Z" }), [], NOW),
    ).toThrow(/not a valid transition/);
  });

  it("isCampaignCompletable agrees with completeCampaign in both directions", () => {
    expect(isCampaignCompletable(running(), [resolved("ari_00000001")])).toBe(true);
    expect(
      isCampaignCompletable(running(), [makeItem({ id: "ari_00000002", status: "pending" })]),
    ).toBe(false);
    expect(isCampaignCompletable(makeCampaign({ status: "scheduled" }), [])).toBe(false);
  });

  it("unresolvedItems lists exactly what blocks the close", () => {
    const items = [
      resolved("ari_00000001"),
      makeItem({ id: "ari_00000002", status: "pending" }),
      makeItem({ id: "ari_00000003", status: "escalated", openedForReviewAt: "2026-01-05T00:00:00.000Z", currentReviewer: reviewerState }),
    ];
    expect(unresolvedItems(items).map((i) => i.id)).toEqual(["ari_00000002", "ari_00000003"]);
  });

  it("unblocks planNextOccurrence, which could not fire before anything completed", () => {
    const ids = new CountingIdGenerator();
    const done = completeCampaign(running(), [], NOW);
    expect(planNextOccurrence(done, NOW, ids)).not.toBeNull();
  });
});
