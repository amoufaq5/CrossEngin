import { sha256 } from "@crossengin/crypto";
import {
  DELIVERY_OUTCOMES,
  DISPATCH_STATUSES,
  DeliveryAttemptSchema,
  NotificationDispatchSchema,
  canTransitionDispatch,
  type DeliveryAttempt,
  type DispatchStatus,
  type NotificationChannel,
  type NotificationDispatch,
  type SuppressionRecord,
  type UserPreferenceMatrix,
} from "@crossengin/notifications";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INITIAL_BACKOFF_SECONDS,
  DEFAULT_MAX_DELIVERY_ATTEMPTS,
  advanceDispatch,
  buildDeliveryAttempt,
  deliveryAttemptId,
  dispatchStatusPath,
  planDelivery,
  planRetry,
  type DrainRecipient,
} from "./delivery-plan.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-23T12:00:00.000Z");

const userId = (n: number): string =>
  `2222222${n}-2222-4222-8222-222222222222`;

const prefs = (
  n: number,
  entries: UserPreferenceMatrix["entries"] = [],
): UserPreferenceMatrix => ({
  userId: userId(n),
  tenantId: TENANT,
  entries,
  updatedAt: "2026-08-01T00:00:00.000Z",
});

const recipient = (
  n: number,
  address: string,
  entries: UserPreferenceMatrix["entries"] = [],
): DrainRecipient => ({
  userId: userId(n),
  address,
  preferences: prefs(n, entries),
});

const dispatch = (
  overrides: Partial<NotificationDispatch> = {},
): NotificationDispatch => ({
  id: "disp_drain0001",
  tenantId: TENANT,
  templateId: "order.shipped",
  templateVersion: "1.0.0",
  locale: "en-US",
  channel: "email",
  category: "transactional",
  priority: "normal",
  audienceJson: { kind: "tenant_all_users", tenantId: TENANT },
  variablesSha256: sha256("{}"),
  correlationId: null,
  idempotencyKey: "drain-0001",
  status: "queued",
  queuedAt: "2026-08-23T11:59:00.000Z",
  startedAt: null,
  completedAt: null,
  recipientCount: 1,
  deliveredCount: 0,
  failedCount: 0,
  suppressedCount: 0,
  cancelledReason: null,
  requestedBy: null,
  requestingSystem: "operate-server",
  ...overrides,
});

const suppression = (
  address: string,
  channel: NotificationChannel = "email",
): SuppressionRecord => ({
  id: "supp_hardbounce1",
  tenantId: TENANT,
  channel,
  recipientAddress: address,
  reason: "hard_bounce",
  appliedAt: "2026-08-01T00:00:00.000Z",
  appliedBy: null,
  expiresAt: null,
  sourceDeliveryId: null,
});

const attempt = (
  over: Partial<Parameters<typeof buildDeliveryAttempt>[0]> = {},
): DeliveryAttempt =>
  buildDeliveryAttempt({
    dispatch: dispatch(),
    recipientAddressSha256: sha256("a@example.com"),
    attemptNumber: 1,
    outcome: "delivered",
    provider: "ses",
    sentAt: "2026-08-23T12:00:00.000Z",
    finalizedAt: "2026-08-23T12:00:01.250Z",
    ...over,
  });

describe("planDelivery", () => {
  it("marks an opted-in recipient deliverable", () => {
    const plan = planDelivery({
      dispatch: dispatch(),
      recipients: [recipient(1, "a@example.com")],
      suppressions: [],
      now: NOW,
    });
    expect(plan.deliverable).toHaveLength(1);
    expect(plan.ineligible).toHaveLength(0);
    expect(plan.deliverable[0]?.eligibility.reason).toBe("ok");
  });

  it("hashes the recipient address with sha256", () => {
    const plan = planDelivery({
      dispatch: dispatch(),
      recipients: [recipient(1, "a@example.com")],
      suppressions: [],
      now: NOW,
    });
    expect(plan.deliverable[0]?.recipientAddressSha256).toBe(
      sha256("a@example.com"),
    );
    expect(plan.deliverable[0]?.recipientAddressSha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("routes a suppressed address to ineligible for a suppressible category", () => {
    const plan = planDelivery({
      dispatch: dispatch({ category: "marketing" }),
      recipients: [
        recipient(1, "a@example.com", [
          {
            category: "marketing",
            channel: "email",
            optedIn: true,
            updatedAt: "2026-08-01T00:00:00.000Z",
            source: "user_set",
          },
        ]),
      ],
      suppressions: [suppression("a@example.com")],
      now: NOW,
    });
    expect(plan.deliverable).toHaveLength(0);
    expect(plan.ineligible[0]?.eligibility.reason).toBe("suppressed");
    expect(plan.ineligible[0]?.eligibility.suppressionId).toBe(
      "supp_hardbounce1",
    );
  });

  it("keeps a suppressed address deliverable for a non-suppressible category", () => {
    const plan = planDelivery({
      dispatch: dispatch({ category: "security_alert" }),
      recipients: [recipient(1, "a@example.com")],
      suppressions: [suppression("a@example.com")],
      now: NOW,
    });
    expect(plan.deliverable).toHaveLength(1);
    expect(plan.ineligible).toHaveLength(0);
  });

  it("routes a marketing recipient without explicit opt-in to not_opted_in", () => {
    const plan = planDelivery({
      dispatch: dispatch({ category: "marketing" }),
      recipients: [recipient(1, "a@example.com")],
      suppressions: [],
      now: NOW,
    });
    expect(plan.ineligible[0]?.eligibility.reason).toBe("not_opted_in");
    expect(plan.ineligible[0]?.eligibility.eligible).toBe(false);
  });

  it("fans a mixed audience into deliverable and ineligible buckets", () => {
    const plan = planDelivery({
      dispatch: dispatch({ category: "operational_digest" }),
      recipients: [
        recipient(1, "a@example.com"),
        recipient(2, "b@example.com", [
          {
            category: "operational_digest",
            channel: "email",
            optedIn: false,
            updatedAt: "2026-08-01T00:00:00.000Z",
            source: "user_set",
          },
        ]),
        recipient(3, "c@example.com"),
      ],
      suppressions: [suppression("c@example.com")],
      now: NOW,
    });
    expect(plan.deliverable.map((p) => p.recipient.address)).toEqual([
      "a@example.com",
    ]);
    expect(plan.ineligible.map((p) => p.eligibility.reason).sort()).toEqual([
      "not_opted_in",
      "suppressed",
    ]);
    expect(plan.recipientCount).toBe(3);
  });

  it("deduplicates the same address reached through two memberships", () => {
    const plan = planDelivery({
      dispatch: dispatch(),
      recipients: [
        recipient(1, "dup@example.com"),
        recipient(2, "dup@example.com"),
        recipient(3, "other@example.com"),
      ],
      suppressions: [],
      now: NOW,
    });
    expect(plan.recipientCount).toBe(2);
    expect(plan.deliverable).toHaveLength(2);
    expect(plan.deliverable[0]?.recipient.userId).toBe(userId(1));
  });

  it("returns an empty plan for an empty audience", () => {
    const plan = planDelivery({
      dispatch: dispatch(),
      recipients: [],
      suppressions: [],
      now: NOW,
    });
    expect(plan).toEqual({
      deliverable: [],
      ineligible: [],
      recipientCount: 0,
    });
  });
});

describe("buildDeliveryAttempt", () => {
  it("round-trips a delivered attempt through DeliveryAttemptSchema", () => {
    const a = attempt();
    expect(() => DeliveryAttemptSchema.parse(a)).not.toThrow();
    expect(a.attemptKind).toBe("initial");
    expect(a.latencyMs).toBe(1250);
  });

  it("derives a deterministic dlv_ + 32 hex id", () => {
    const a = attempt();
    expect(a.id).toMatch(/^dlv_[0-9a-f]{32}$/);
    expect(a.id).toBe(
      deliveryAttemptId("disp_drain0001", sha256("a@example.com"), 1),
    );
    expect(attempt().id).toBe(a.id);
  });

  it("gives different ids to different attempt numbers", () => {
    const first = attempt();
    const second = attempt({
      attemptNumber: 2,
      outcome: "deferred",
      nextRetryAt: "2026-08-23T12:01:00.000Z",
    });
    expect(second.id).not.toBe(first.id);
  });

  it("marks attemptNumber >= 2 as a retry", () => {
    const a = attempt({
      attemptNumber: 3,
      outcome: "delivered",
      nextRetryAt: null,
    });
    expect(a.attemptKind).toBe("retry");
    expect(() => DeliveryAttemptSchema.parse(a)).not.toThrow();
  });

  it("computes null latency when sentAt or finalizedAt is missing", () => {
    const a = attempt({ sentAt: null, finalizedAt: null });
    expect(a.latencyMs).toBeNull();
    expect(() => DeliveryAttemptSchema.parse(a)).not.toThrow();
  });

  it("defaults errorCode for a failed outcome", () => {
    const a = attempt({
      outcome: "failed",
      nextRetryAt: "2026-08-23T12:00:30.000Z",
    });
    expect(a.errorCode).toBe("delivery_failed");
    expect(() => DeliveryAttemptSchema.parse(a)).not.toThrow();
  });

  it("defaults errorCode for bounced_hard and bounced_soft", () => {
    const hard = attempt({ outcome: "bounced_hard" });
    const soft = attempt({
      outcome: "bounced_soft",
      nextRetryAt: "2026-08-23T12:00:30.000Z",
    });
    expect(hard.errorCode).toBe("delivery_failed");
    expect(soft.errorCode).toBe("delivery_failed");
    expect(() => DeliveryAttemptSchema.parse(hard)).not.toThrow();
    expect(() => DeliveryAttemptSchema.parse(soft)).not.toThrow();
  });

  it("keeps a caller-supplied errorCode", () => {
    const a = attempt({
      outcome: "bounced_hard",
      errorCode: "smtp_550",
      errorMessage: "mailbox unavailable",
    });
    expect(a.errorCode).toBe("smtp_550");
    expect(a.errorMessage).toBe("mailbox unavailable");
  });

  it("defaults smsSegments to 1 for a delivered sms", () => {
    const a = buildDeliveryAttempt({
      dispatch: dispatch({ channel: "sms" }),
      recipientAddressSha256: sha256("+15550001111"),
      attemptNumber: 1,
      outcome: "delivered",
      provider: "twilio",
      sentAt: "2026-08-23T12:00:00.000Z",
      finalizedAt: "2026-08-23T12:00:00.400Z",
    });
    expect(a.smsSegments).toBe(1);
    expect(() => DeliveryAttemptSchema.parse(a)).not.toThrow();
  });

  it("keeps a caller-supplied smsSegments", () => {
    const a = buildDeliveryAttempt({
      dispatch: dispatch({ channel: "sms" }),
      recipientAddressSha256: sha256("+15550001111"),
      attemptNumber: 1,
      outcome: "delivered",
      provider: "twilio",
      sentAt: "2026-08-23T12:00:00.000Z",
      finalizedAt: "2026-08-23T12:00:00.400Z",
      smsSegments: 3,
    });
    expect(a.smsSegments).toBe(3);
    expect(() => DeliveryAttemptSchema.parse(a)).not.toThrow();
  });

  it("leaves smsSegments null for a non-delivered sms", () => {
    const a = buildDeliveryAttempt({
      dispatch: dispatch({ channel: "sms" }),
      recipientAddressSha256: sha256("+15550001111"),
      attemptNumber: 1,
      outcome: "dropped",
      provider: "twilio",
      sentAt: null,
      finalizedAt: "2026-08-23T12:00:00.400Z",
    });
    expect(a.smsSegments).toBeNull();
    expect(() => DeliveryAttemptSchema.parse(a)).not.toThrow();
  });

  it("throws when a retryable outcome carries no nextRetryAt", () => {
    expect(() => attempt({ outcome: "deferred" })).toThrow(/requires nextRetryAt/);
  });

  it("throws when a terminal outcome carries a nextRetryAt", () => {
    expect(() =>
      attempt({ outcome: "delivered", nextRetryAt: "2026-08-23T12:05:00.000Z" }),
    ).toThrow(/must not carry nextRetryAt/);
  });

  it("throws on a non-positive attemptNumber", () => {
    expect(() => attempt({ attemptNumber: 0 })).toThrow(
      /positive integer/,
    );
  });

  it("round-trips every delivery outcome paired with its retry decision", () => {
    for (const outcome of DELIVERY_OUTCOMES) {
      const retry = planRetry({ outcome, attemptNumber: 1, now: NOW });
      const a = attempt({ outcome, nextRetryAt: retry.nextRetryAt });
      expect(() => DeliveryAttemptSchema.parse(a)).not.toThrow();
    }
  });

  it("carries provider metadata through untouched", () => {
    const a = attempt({
      provider: "sendgrid",
      providerMessageId: "msg-42",
      httpStatus: 202,
      bytesSent: 4096,
    });
    expect(a.provider).toBe("sendgrid");
    expect(a.providerMessageId).toBe("msg-42");
    expect(a.httpStatus).toBe(202);
    expect(a.bytesSent).toBe(4096);
    expect(() => DeliveryAttemptSchema.parse(a)).not.toThrow();
  });
});

describe("dispatchStatusPath", () => {
  it("walks queued to completed through the rendering states", () => {
    expect(dispatchStatusPath("queued", "completed")).toEqual([
      "rendering",
      "rendered",
      "sending",
      "completed",
    ]);
  });

  it("returns an empty path when from equals to", () => {
    expect(dispatchStatusPath("sending", "sending")).toEqual([]);
  });

  it("produces a legal walk under canTransitionDispatch for every reachable pair", () => {
    for (const from of DISPATCH_STATUSES) {
      for (const to of DISPATCH_STATUSES) {
        let path: readonly DispatchStatus[];
        try {
          path = dispatchStatusPath(from, to);
        } catch {
          continue;
        }
        let cursor: DispatchStatus = from;
        for (const next of path) {
          expect(canTransitionDispatch(cursor, next)).toBe(true);
          cursor = next;
        }
        expect(path.length === 0 ? from : cursor).toBe(to);
      }
    }
  });

  it("throws for an impossible walk out of a terminal status", () => {
    expect(() => dispatchStatusPath("completed", "sending")).toThrow(
      /no legal dispatch status path/,
    );
    expect(() => dispatchStatusPath("failed", "completed")).toThrow();
    expect(() => dispatchStatusPath("cancelled", "sending")).toThrow();
  });

  it("finds the shortest path from queued to failed", () => {
    expect(dispatchStatusPath("queued", "failed")).toEqual([
      "rendering",
      "failed",
    ]);
  });

  it("walks sending to completed in one step", () => {
    expect(dispatchStatusPath("sending", "completed")).toEqual(["completed"]);
  });
});

describe("advanceDispatch", () => {
  const twoDeliverable = (): ReturnType<typeof planDelivery> =>
    planDelivery({
      dispatch: dispatch(),
      recipients: [recipient(1, "a@example.com"), recipient(2, "b@example.com")],
      suppressions: [],
      now: NOW,
    });

  it("completes when every deliverable recipient was delivered", () => {
    const plan = twoDeliverable();
    const attempts = plan.deliverable.map((p) =>
      attempt({ recipientAddressSha256: p.recipientAddressSha256 }),
    );
    const advance = advanceDispatch({
      dispatch: dispatch(),
      plan,
      attempts,
      startedAt: "2026-08-23T11:59:30.000Z",
      now: NOW,
    });
    expect(advance.status).toBe("completed");
    expect(advance.statusPath.at(-1)).toBe("completed");
    expect(advance.deliveredCount).toBe(2);
    expect(advance.failedCount).toBe(0);
    expect(advance.recipientCount).toBe(2);
    expect(advance.completedAt).toBe(NOW.toISOString());
    expect(advance.startedAt).toBe("2026-08-23T11:59:30.000Z");
  });

  it("fails when there were deliverable recipients and none delivered", () => {
    const plan = twoDeliverable();
    const attempts = plan.deliverable.map((p) =>
      attempt({
        recipientAddressSha256: p.recipientAddressSha256,
        outcome: "bounced_hard",
      }),
    );
    const advance = advanceDispatch({
      dispatch: dispatch(),
      plan,
      attempts,
      startedAt: "2026-08-23T11:59:30.000Z",
      now: NOW,
    });
    expect(advance.status).toBe("failed");
    expect(advance.failedCount).toBe(2);
    expect(advance.deliveredCount).toBe(0);
    expect(advance.completedAt).toBe(NOW.toISOString());
  });

  it("treats zero deliverable recipients as a completion", () => {
    const plan = planDelivery({
      dispatch: dispatch({ category: "marketing" }),
      recipients: [recipient(1, "a@example.com"), recipient(2, "b@example.com")],
      suppressions: [],
      now: NOW,
    });
    expect(plan.deliverable).toHaveLength(0);
    const advance = advanceDispatch({
      dispatch: dispatch(),
      plan,
      attempts: [],
      startedAt: "2026-08-23T11:59:30.000Z",
      now: NOW,
    });
    expect(advance.status).toBe("completed");
    expect(advance.suppressedCount).toBe(2);
    expect(advance.deliveredCount).toBe(0);
    expect(advance.failedCount).toBe(0);
    expect(advance.completedAt).toBe(NOW.toISOString());
  });

  it("stays sending while any attempt awaits a retry", () => {
    const plan = twoDeliverable();
    const first = plan.deliverable[0];
    const second = plan.deliverable[1];
    if (first === undefined || second === undefined) throw new Error("fixture");
    const attempts = [
      attempt({ recipientAddressSha256: first.recipientAddressSha256 }),
      attempt({
        recipientAddressSha256: second.recipientAddressSha256,
        outcome: "deferred",
        nextRetryAt: "2026-08-23T12:00:30.000Z",
      }),
    ];
    const advance = advanceDispatch({
      dispatch: dispatch(),
      plan,
      attempts,
      startedAt: "2026-08-23T11:59:30.000Z",
      now: NOW,
    });
    expect(advance.status).toBe("sending");
    expect(advance.statusPath).toEqual(["rendering", "rendered", "sending"]);
    expect(advance.completedAt).toBeNull();
    expect(advance.failedCount).toBe(0);
  });

  it("counts an exhausted retryable outcome as failed", () => {
    const plan = twoDeliverable();
    const attempts: DeliveryAttempt[] = plan.deliverable.map((p) => ({
      ...attempt({
        recipientAddressSha256: p.recipientAddressSha256,
        attemptNumber: DEFAULT_MAX_DELIVERY_ATTEMPTS,
      }),
      outcome: "rate_limited",
      nextRetryAt: null,
    }));
    const advance = advanceDispatch({
      dispatch: dispatch(),
      plan,
      attempts,
      startedAt: "2026-08-23T11:59:30.000Z",
      now: NOW,
    });
    expect(advance.failedCount).toBe(2);
    expect(advance.status).toBe("failed");
  });

  it("adds attempt-level suppressions to the plan-level suppressed count", () => {
    const plan = planDelivery({
      dispatch: dispatch({ category: "operational_digest" }),
      recipients: [
        recipient(1, "a@example.com"),
        recipient(2, "b@example.com", [
          {
            category: "operational_digest",
            channel: "email",
            optedIn: false,
            updatedAt: "2026-08-01T00:00:00.000Z",
            source: "user_set",
          },
        ]),
      ],
      suppressions: [],
      now: NOW,
    });
    const first = plan.deliverable[0];
    if (first === undefined) throw new Error("fixture");
    const advance = advanceDispatch({
      dispatch: dispatch(),
      plan,
      attempts: [
        attempt({
          recipientAddressSha256: first.recipientAddressSha256,
          outcome: "suppressed",
        }),
      ],
      startedAt: "2026-08-23T11:59:30.000Z",
      now: NOW,
    });
    expect(advance.suppressedCount).toBe(2);
    expect(advance.deliveredCount).toBe(0);
    expect(advance.status).toBe("failed");
  });

  it("raises recipientCount above the queued placeholder so the dispatch stays schema-valid", () => {
    const plan = twoDeliverable();
    const attempts = plan.deliverable.map((p) =>
      attempt({ recipientAddressSha256: p.recipientAddressSha256 }),
    );
    const queued = dispatch({ recipientCount: 1 });
    const advance = advanceDispatch({
      dispatch: queued,
      plan,
      attempts,
      startedAt: "2026-08-23T11:59:30.000Z",
      now: NOW,
    });
    expect(queued.recipientCount).toBe(1);
    expect(advance.recipientCount).toBe(2);
    const updated = {
      ...queued,
      status: advance.status,
      startedAt: advance.startedAt,
      completedAt: advance.completedAt,
      recipientCount: advance.recipientCount,
      deliveredCount: advance.deliveredCount,
      failedCount: advance.failedCount,
      suppressedCount: advance.suppressedCount,
    };
    expect(() => NotificationDispatchSchema.parse(updated)).not.toThrow();
  });

  it("never lets delivered + failed + suppressed exceed recipientCount", () => {
    const plan: ReturnType<typeof planDelivery> = {
      deliverable: [],
      ineligible: [],
      recipientCount: 0,
    };
    const advance = advanceDispatch({
      dispatch: dispatch(),
      plan,
      attempts: [attempt(), attempt({ recipientAddressSha256: sha256("z") })],
      startedAt: "2026-08-23T11:59:30.000Z",
      now: NOW,
    });
    expect(advance.deliveredCount).toBe(2);
    expect(
      advance.deliveredCount + advance.failedCount + advance.suppressedCount,
    ).toBeLessThanOrEqual(advance.recipientCount);
  });

});

describe("planRetry", () => {
  it("schedules a retry at the default initial backoff", () => {
    const decision = planRetry({
      outcome: "deferred",
      attemptNumber: 1,
      now: NOW,
    });
    expect(decision.shouldRetry).toBe(true);
    expect(decision.nextRetryAt).toBe(
      new Date(
        NOW.getTime() + DEFAULT_INITIAL_BACKOFF_SECONDS * 1000,
      ).toISOString(),
    );
  });

  it("refuses to retry a terminal outcome", () => {
    const decision = planRetry({
      outcome: "bounced_hard",
      attemptNumber: 1,
      now: NOW,
    });
    expect(decision).toEqual({
      shouldRetry: false,
      nextRetryAt: null,
      reason: "outcome_not_retryable",
    });
  });

  it("stops retrying at the default max attempts", () => {
    const decision = planRetry({
      outcome: "failed",
      attemptNumber: DEFAULT_MAX_DELIVERY_ATTEMPTS,
      now: NOW,
    });
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toBe("max_attempts_exhausted");
  });

  it("honours caller overrides", () => {
    const decision = planRetry({
      outcome: "rate_limited",
      attemptNumber: 2,
      now: NOW,
      maxAttempts: 3,
      initialBackoffSeconds: 10,
    });
    expect(decision.shouldRetry).toBe(true);
    expect(decision.reason).toBe("retry_in_20s");
  });

  it("feeds straight into buildDeliveryAttempt", () => {
    const decision = planRetry({
      outcome: "bounced_soft",
      attemptNumber: 2,
      now: NOW,
    });
    const a = attempt({
      attemptNumber: 2,
      outcome: "bounced_soft",
      nextRetryAt: decision.nextRetryAt,
    });
    expect(() => DeliveryAttemptSchema.parse(a)).not.toThrow();
    expect(a.nextRetryAt).toBe(decision.nextRetryAt);
  });
});
