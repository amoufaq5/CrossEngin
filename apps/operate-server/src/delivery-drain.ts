import {
  RETRYABLE_DELIVERY_OUTCOMES,
  type DeliveryAttempt,
  type DeliveryOutcome,
  type NotificationChannel,
  type NotificationDispatch,
  type ProviderKind,
  type SuppressionRecord,
  type UserPreferenceMatrix,
} from "@crossengin/notifications";

import {
  advanceDispatch,
  buildDeliveryAttempt,
  planDelivery,
  planRetry,
  type DrainRecipient,
} from "./delivery-plan.js";
import {
  sendWithTimeout,
  unroutedResult,
  type SendResult,
  type SenderRegistry,
  type SendTimer,
} from "./delivery-senders.js";
import type { ClaimedDispatch, DispatchAdvanceUpdate, DueRetry } from "./delivery-store.js";
import type { ResolvedRecipient } from "./recipient-resolver.js";

export interface DeliveryStoreLike {
  claimQueued(tenantId: string, limit?: number): Promise<readonly ClaimedDispatch[]>;
  recordAttempt(tenantId: string, rowId: string, attempt: DeliveryAttempt): Promise<boolean>;
  advance(tenantId: string, rowId: string, update: DispatchAdvanceUpdate): Promise<boolean>;
  dueRetries(tenantId: string, now: Date, limit?: number): Promise<readonly DueRetry[]>;
}

export interface RecipientResolverLike {
  resolveAudience(tenantId: string, audience: unknown): Promise<readonly ResolvedRecipient[]>;
  preferencesFor(
    tenantId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, UserPreferenceMatrix>>;
  activeSuppressions(
    tenantId: string,
    channel: NotificationChannel,
    now: Date,
  ): Promise<readonly SuppressionRecord[]>;
}

export interface DeliveryDrainOptions {
  readonly store: DeliveryStoreLike;
  readonly resolver: RecipientResolverLike;
  readonly senders: SenderRegistry;
  readonly clock?: () => Date;
  readonly batchSize?: number;
  readonly sendTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly timer?: SendTimer;
  readonly onError?: (err: unknown, tenantId: string) => void;
}

export interface DrainReport {
  readonly tenantId: string;
  readonly dispatches: number;
  readonly delivered: number;
  readonly failed: number;
  readonly suppressed: number;
  readonly retryScheduled: number;
  readonly retriesAttempted: number;
}

export interface MultiTenantDrainReport {
  readonly tenants: number;
  readonly reports: readonly DrainReport[];
  readonly dispatches: number;
  readonly delivered: number;
  readonly failed: number;
  readonly suppressed: number;
  readonly retryScheduled: number;
}

export const DEFAULT_DRAIN_BATCH_SIZE = 25;

/** The channel decides what an "address" is; suppressions and preferences are keyed by it. */
export function addressFor(
  channel: NotificationChannel,
  recipient: ResolvedRecipient,
): string {
  return channel === "in_app" || channel === "push_mobile"
    ? recipient.userId
    : recipient.email;
}

export function emptyPreferenceMatrix(
  tenantId: string,
  userId: string,
  now: Date,
): UserPreferenceMatrix {
  return { userId, tenantId, entries: [], updatedAt: now.toISOString() };
}

/**
 * A retryable outcome with no retries left cannot be written as-is: DeliveryAttemptSchema
 * requires nextRetryAt for every retryable outcome, so an exhausted `failed` has no valid
 * representation. `dropped` is the terminal outcome that means exactly this — gave up — and it
 * keeps the original errorCode, so the audit still says why.
 */
export function terminalOutcomeFor(
  outcome: DeliveryOutcome,
  willRetry: boolean,
): DeliveryOutcome {
  if (willRetry) return outcome;
  return RETRYABLE_DELIVERY_OUTCOMES.has(outcome) ? "dropped" : outcome;
}

function providerFor(senders: SenderRegistry, channel: NotificationChannel): ProviderKind {
  return senders.for(channel)?.provider ?? unroutedResult(channel).provider;
}

async function sendOnce(
  opts: DeliveryDrainOptions,
  dispatch: NotificationDispatch,
  recipientAddress: string,
  attemptNumber: number,
): Promise<SendResult> {
  const sender = opts.senders.for(dispatch.channel);
  if (sender === null) return unroutedResult(dispatch.channel);
  return sendWithTimeout(
    sender,
    {
      dispatchId: dispatch.id,
      tenantId: dispatch.tenantId,
      channel: dispatch.channel,
      templateId: dispatch.templateId,
      locale: dispatch.locale,
      recipientAddress,
      attemptNumber,
    },
    opts.sendTimeoutMs,
    opts.timer,
  );
}

function attemptFromResult(
  opts: DeliveryDrainOptions,
  dispatch: NotificationDispatch,
  recipientAddressSha256: string,
  attemptNumber: number,
  result: SendResult,
  sentAt: string,
  finalizedAt: string,
  now: Date,
): DeliveryAttempt {
  const retry = planRetry({
    outcome: result.outcome,
    attemptNumber,
    now,
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
  });
  const outcome = terminalOutcomeFor(result.outcome, retry.shouldRetry);
  return buildDeliveryAttempt({
    dispatch,
    recipientAddressSha256,
    attemptNumber,
    outcome,
    provider: result.provider,
    sentAt,
    finalizedAt,
    providerMessageId: result.providerMessageId,
    httpStatus: result.httpStatus,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    nextRetryAt: retry.shouldRetry ? retry.nextRetryAt : null,
  });
}

async function drainDispatch(
  opts: DeliveryDrainOptions,
  tenantId: string,
  claimed: ClaimedDispatch,
): Promise<{ attempts: readonly DeliveryAttempt[]; suppressed: number; retryScheduled: number }> {
  const now = opts.clock ?? ((): Date => new Date());
  const startedAt = now().toISOString();
  const dispatch = claimed.dispatch;

  const resolved = await opts.resolver.resolveAudience(tenantId, dispatch.audienceJson);
  const preferences = await opts.resolver.preferencesFor(
    tenantId,
    resolved.map((r) => r.userId),
  );
  const suppressions = await opts.resolver.activeSuppressions(
    tenantId,
    dispatch.channel,
    now(),
  );

  const recipients: DrainRecipient[] = resolved.map((r) => ({
    userId: r.userId,
    address: addressFor(dispatch.channel, r),
    preferences:
      preferences.get(r.userId) ?? emptyPreferenceMatrix(tenantId, r.userId, now()),
  }));

  const plan = planDelivery({ dispatch, recipients, suppressions, now: now() });
  const provider = providerFor(opts.senders, dispatch.channel);
  const attempts: DeliveryAttempt[] = [];

  for (const ineligible of plan.ineligible) {
    const at = now().toISOString();
    attempts.push(
      buildDeliveryAttempt({
        dispatch,
        recipientAddressSha256: ineligible.recipientAddressSha256,
        attemptNumber: 1,
        outcome: "suppressed",
        provider,
        sentAt: null,
        finalizedAt: at,
        errorMessage: ineligible.eligibility.reason,
      }),
    );
  }

  for (const target of plan.deliverable) {
    const sentAt = now().toISOString();
    const result = await sendOnce(opts, dispatch, target.recipient.address, 1);
    attempts.push(
      attemptFromResult(
        opts,
        dispatch,
        target.recipientAddressSha256,
        1,
        result,
        sentAt,
        now().toISOString(),
        now(),
      ),
    );
  }

  for (const attempt of attempts) {
    await opts.store.recordAttempt(tenantId, claimed.rowId, attempt);
  }

  const advance = advanceDispatch({ dispatch, plan, attempts, startedAt, now: now() });
  await opts.store.advance(tenantId, claimed.rowId, {
    status: advance.status,
    startedAt: advance.startedAt,
    completedAt: advance.completedAt,
    recipientCount: advance.recipientCount,
    deliveredCount: advance.deliveredCount,
    failedCount: advance.failedCount,
    suppressedCount: advance.suppressedCount,
  });

  return {
    attempts,
    suppressed: advance.suppressedCount,
    retryScheduled: attempts.filter((a) => a.nextRetryAt !== null).length,
  };
}

/**
 * Re-sending a retry needs the recipient's address, but only its hash was persisted — the
 * dispatch deliberately stores no recipient identities. So the audience is re-resolved and
 * matched back by hash; a recipient who has since left the audience simply drops out.
 */
async function drainRetry(
  opts: DeliveryDrainOptions,
  tenantId: string,
  due: DueRetry,
): Promise<DeliveryAttempt | null> {
  const now = opts.clock ?? ((): Date => new Date());
  const dispatch = due.dispatch;
  const resolved = await opts.resolver.resolveAudience(tenantId, dispatch.audienceJson);
  const recipients: DrainRecipient[] = resolved.map((r) => ({
    userId: r.userId,
    address: addressFor(dispatch.channel, r),
    preferences: emptyPreferenceMatrix(tenantId, r.userId, now()),
  }));
  const suppressions = await opts.resolver.activeSuppressions(tenantId, dispatch.channel, now());
  const plan = planDelivery({ dispatch, recipients, suppressions, now: now() });
  const target = plan.deliverable.find(
    (p) => p.recipientAddressSha256 === due.recipientAddressSha256,
  );
  if (target === undefined) return null;

  const attemptNumber = due.attemptNumber + 1;
  const sentAt = now().toISOString();
  const result = await sendOnce(opts, dispatch, target.recipient.address, attemptNumber);
  const attempt = attemptFromResult(
    opts,
    dispatch,
    due.recipientAddressSha256,
    attemptNumber,
    result,
    sentAt,
    now().toISOString(),
    now(),
  );
  await opts.store.recordAttempt(tenantId, due.rowId, attempt);
  return attempt;
}

export async function drainTenant(
  opts: DeliveryDrainOptions,
  tenantId: string,
): Promise<DrainReport> {
  const now = opts.clock ?? ((): Date => new Date());
  const batch = opts.batchSize ?? DEFAULT_DRAIN_BATCH_SIZE;
  let delivered = 0;
  let failed = 0;
  let suppressed = 0;
  let retryScheduled = 0;
  let retriesAttempted = 0;

  const claimed = await opts.store.claimQueued(tenantId, batch);
  for (const one of claimed) {
    const result = await drainDispatch(opts, tenantId, one);
    for (const a of result.attempts) {
      if (a.outcome === "delivered") delivered += 1;
      else if (a.outcome !== "suppressed" && a.nextRetryAt === null) failed += 1;
    }
    suppressed += result.suppressed;
    retryScheduled += result.retryScheduled;
  }

  const due = await opts.store.dueRetries(tenantId, now(), batch);
  for (const one of due) {
    const attempt = await drainRetry(opts, tenantId, one);
    if (attempt === null) continue;
    retriesAttempted += 1;
    if (attempt.outcome === "delivered") delivered += 1;
    else if (attempt.nextRetryAt !== null) retryScheduled += 1;
    else failed += 1;
  }

  return {
    tenantId,
    dispatches: claimed.length,
    delivered,
    failed,
    suppressed,
    retryScheduled,
    retriesAttempted,
  };
}

export async function drainTenants(
  opts: DeliveryDrainOptions,
  tenantIds: readonly string[],
): Promise<MultiTenantDrainReport> {
  const reports: DrainReport[] = [];
  for (const tenantId of tenantIds) {
    try {
      reports.push(await drainTenant(opts, tenantId));
    } catch (err) {
      // One tenant's failure must not stop the sweep for the rest.
      opts.onError?.(err, tenantId);
    }
  }
  return {
    tenants: reports.length,
    reports,
    dispatches: reports.reduce((n, r) => n + r.dispatches, 0),
    delivered: reports.reduce((n, r) => n + r.delivered, 0),
    failed: reports.reduce((n, r) => n + r.failed, 0),
    suppressed: reports.reduce((n, r) => n + r.suppressed, 0),
    retryScheduled: reports.reduce((n, r) => n + r.retryScheduled, 0),
  };
}
