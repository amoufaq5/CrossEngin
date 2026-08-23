import { sha256 } from "@crossengin/crypto";
import {
  DISPATCH_TRANSITIONS,
  RETRYABLE_DELIVERY_OUTCOMES,
  TERMINAL_DELIVERY_OUTCOMES,
  computeDispatchEligibility,
  decideRetry,
  type DeliveryAttempt,
  type DeliveryOutcome,
  type DispatchEligibility,
  type DispatchStatus,
  type NotificationDispatch,
  type ProviderKind,
  type RetryDecision,
  type SuppressionRecord,
  type UserPreferenceMatrix,
} from "@crossengin/notifications";

export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5;
export const DEFAULT_INITIAL_BACKOFF_SECONDS = 30;
export const DEFAULT_DELIVERY_ERROR_CODE = "delivery_failed";

export interface DrainRecipient {
  readonly userId: string;
  readonly address: string;
  readonly preferences: UserPreferenceMatrix;
}

export interface PlannedRecipient {
  readonly recipient: DrainRecipient;
  readonly recipientAddressSha256: string;
  readonly eligibility: DispatchEligibility;
}

export interface DeliveryPlan {
  readonly deliverable: readonly PlannedRecipient[];
  readonly ineligible: readonly PlannedRecipient[];
  readonly recipientCount: number;
}

export function planDelivery(input: {
  readonly dispatch: NotificationDispatch;
  readonly recipients: readonly DrainRecipient[];
  readonly suppressions: readonly SuppressionRecord[];
  readonly now: Date;
}): DeliveryPlan {
  const deliverable: PlannedRecipient[] = [];
  const ineligible: PlannedRecipient[] = [];
  const seen = new Set<string>();

  for (const recipient of input.recipients) {
    const recipientAddressSha256 = sha256(recipient.address);
    // One address is one delivery: the same address reached through two
    // audience memberships must not be notified twice.
    if (seen.has(recipientAddressSha256)) continue;
    seen.add(recipientAddressSha256);

    const eligibility = computeDispatchEligibility({
      category: input.dispatch.category,
      channel: input.dispatch.channel,
      preferences: recipient.preferences,
      suppressions: input.suppressions,
      recipientAddress: recipient.address,
      now: input.now,
    });
    const planned: PlannedRecipient = {
      recipient,
      recipientAddressSha256,
      eligibility,
    };
    if (eligibility.eligible) deliverable.push(planned);
    else ineligible.push(planned);
  }

  return {
    deliverable,
    ineligible,
    recipientCount: deliverable.length + ineligible.length,
  };
}

export function deliveryAttemptId(
  dispatchId: string,
  recipientAddressSha256: string,
  attemptNumber: number,
): string {
  const digest = sha256(
    `${dispatchId}:${recipientAddressSha256}:${attemptNumber}`,
  );
  return `dlv_${digest.slice(0, 32)}`;
}

export function buildDeliveryAttempt(input: {
  readonly dispatch: NotificationDispatch;
  readonly recipientAddressSha256: string;
  readonly attemptNumber: number;
  readonly outcome: DeliveryOutcome;
  readonly provider: ProviderKind;
  readonly sentAt: string | null;
  readonly finalizedAt: string | null;
  readonly providerMessageId?: string | null;
  readonly httpStatus?: number | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly nextRetryAt?: string | null;
  readonly smsSegments?: number | null;
  readonly bytesSent?: number | null;
}): DeliveryAttempt {
  if (!Number.isInteger(input.attemptNumber) || input.attemptNumber < 1) {
    throw new Error(
      `attemptNumber must be a positive integer, got ${input.attemptNumber}`,
    );
  }

  const nextRetryAt = input.nextRetryAt ?? null;
  if (RETRYABLE_DELIVERY_OUTCOMES.has(input.outcome) && nextRetryAt === null) {
    throw new Error(
      `retryable outcome ${input.outcome} requires nextRetryAt; pass the value from planRetry`,
    );
  }
  if (TERMINAL_DELIVERY_OUTCOMES.has(input.outcome) && nextRetryAt !== null) {
    throw new Error(
      `terminal outcome ${input.outcome} must not carry nextRetryAt (got ${nextRetryAt})`,
    );
  }

  const needsErrorCode =
    input.outcome === "bounced_hard" ||
    input.outcome === "bounced_soft" ||
    input.outcome === "failed";
  const errorCode =
    input.errorCode ?? (needsErrorCode ? DEFAULT_DELIVERY_ERROR_CODE : null);

  const explicitSegments = input.smsSegments ?? null;
  const smsSegments =
    explicitSegments ??
    (input.dispatch.channel === "sms" && input.outcome === "delivered"
      ? 1
      : null);

  const latencyMs =
    input.sentAt !== null && input.finalizedAt !== null
      ? Date.parse(input.finalizedAt) - Date.parse(input.sentAt)
      : null;

  return {
    id: deliveryAttemptId(
      input.dispatch.id,
      input.recipientAddressSha256,
      input.attemptNumber,
    ),
    dispatchId: input.dispatch.id,
    tenantId: input.dispatch.tenantId,
    channel: input.dispatch.channel,
    provider: input.provider,
    recipientAddressSha256: input.recipientAddressSha256,
    attemptKind: input.attemptNumber === 1 ? "initial" : "retry",
    attemptNumber: input.attemptNumber,
    queuedAt: input.dispatch.queuedAt,
    sentAt: input.sentAt,
    finalizedAt: input.finalizedAt,
    latencyMs,
    outcome: input.outcome,
    providerMessageId: input.providerMessageId ?? null,
    httpStatus: input.httpStatus ?? null,
    bytesSent: input.bytesSent ?? null,
    smsSegments,
    errorCode,
    errorMessage: input.errorMessage ?? null,
    nextRetryAt,
  };
}

export function dispatchStatusPath(
  from: DispatchStatus,
  to: DispatchStatus,
): readonly DispatchStatus[] {
  if (from === to) return [];
  const queue: DispatchStatus[] = [from];
  const previous = new Map<DispatchStatus, DispatchStatus>();
  const visited = new Set<DispatchStatus>([from]);

  while (queue.length > 0) {
    const current = queue.shift() as DispatchStatus;
    for (const next of DISPATCH_TRANSITIONS[current]) {
      if (visited.has(next)) continue;
      visited.add(next);
      previous.set(next, current);
      if (next === to) {
        const path: DispatchStatus[] = [];
        let cursor: DispatchStatus = to;
        while (cursor !== from) {
          path.unshift(cursor);
          const parent = previous.get(cursor);
          if (parent === undefined) break;
          cursor = parent;
        }
        return path;
      }
      queue.push(next);
    }
  }

  throw new Error(`no legal dispatch status path from ${from} to ${to}`);
}

export interface DispatchAdvance {
  readonly statusPath: readonly DispatchStatus[];
  readonly status: DispatchStatus;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly deliveredCount: number;
  readonly failedCount: number;
  readonly suppressedCount: number;
  readonly recipientCount: number;
}

const isFailureOutcome = (attempt: DeliveryAttempt): boolean => {
  if (attempt.outcome === "delivered" || attempt.outcome === "suppressed") {
    return false;
  }
  if (TERMINAL_DELIVERY_OUTCOMES.has(attempt.outcome)) return true;
  return (
    RETRYABLE_DELIVERY_OUTCOMES.has(attempt.outcome) &&
    attempt.nextRetryAt === null
  );
};

export function advanceDispatch(input: {
  readonly dispatch: NotificationDispatch;
  readonly plan: DeliveryPlan;
  readonly attempts: readonly DeliveryAttempt[];
  readonly startedAt: string;
  readonly now: Date;
}): DispatchAdvance {
  // These are per-RECIPIENT counters, not per-attempt: a caller that materialises an ineligible
  // recipient as a `suppressed` attempt (the drain does) must not have it counted twice, and a
  // retried address must not count as two failures.
  const latest = new Map<string, DeliveryAttempt>();
  for (const attempt of input.attempts) latest.set(attempt.recipientAddressSha256, attempt);

  const suppressedAddresses = new Set(
    input.plan.ineligible.map((p) => p.recipientAddressSha256),
  );
  for (const [address, attempt] of latest) {
    if (attempt.outcome === "suppressed") suppressedAddresses.add(address);
  }

  let deliveredCount = 0;
  let failedCount = 0;
  for (const [address, attempt] of latest) {
    if (suppressedAddresses.has(address)) continue;
    if (attempt.outcome === "delivered") deliveredCount += 1;
    else if (isFailureOutcome(attempt)) failedCount += 1;
  }
  const suppressedCount = suppressedAddresses.size;

  const retryPending = input.attempts.some((a) => a.nextRetryAt !== null);
  const status: DispatchStatus = retryPending
    ? "sending"
    : input.plan.deliverable.length === 0 || deliveredCount > 0
      ? "completed"
      : "failed";

  const statusPath = dispatchStatusPath(input.dispatch.status, status);

  // The queued dispatch carries a placeholder recipientCount for an unresolved
  // audience; the schema rejects delivered + failed + suppressed > recipientCount,
  // so the resolved fan-out must never be smaller than what the drain observed.
  const counted = deliveredCount + failedCount + suppressedCount;
  const recipientCount = Math.max(input.plan.recipientCount, counted);

  return {
    statusPath,
    status,
    startedAt: input.startedAt,
    completedAt: retryPending ? null : input.now.toISOString(),
    deliveredCount,
    failedCount,
    suppressedCount,
    recipientCount,
  };
}

export function planRetry(input: {
  readonly outcome: DeliveryOutcome;
  readonly attemptNumber: number;
  readonly now: Date;
  readonly maxAttempts?: number;
  readonly initialBackoffSeconds?: number;
}): RetryDecision {
  return decideRetry({
    outcome: input.outcome,
    attemptNumber: input.attemptNumber,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS,
    initialBackoffSeconds:
      input.initialBackoffSeconds ?? DEFAULT_INITIAL_BACKOFF_SECONDS,
    now: input.now,
  });
}
