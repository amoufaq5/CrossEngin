import { sha256 } from "@crossengin/crypto";
import type { UnreadableRow, UnreadableRowReporter } from "@crossengin/kernel-pg";
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
  type DispatchContent,
} from "./delivery-senders.js";
import type { DispatchContentSource } from "./delivery-content.js";
import type { ClaimedDispatch, DispatchAdvanceUpdate, DueRetry } from "./delivery-store.js";
import {
  DEFAULT_NOTIFICATION_POLICY,
  buildDigestBatch,
  decideThrottle,
  digestWindowFor,
  isBatchableFrequency,
  type NotificationPolicy,
  type ThrottleDecision,
} from "./delivery-throttle.js";
import type { DigestAddResult } from "./digest-store.js";
import type { DigestBatch } from "@crossengin/notifications";
import { isDigestSummary } from "./digest-assembly.js";
import type { ResolvedRecipient } from "./recipient-resolver.js";

export interface DeliveryStoreLike {
  claimQueued(
    tenantId: string,
    onUnreadable: UnreadableRowReporter,
    limit?: number,
  ): Promise<readonly ClaimedDispatch[]>;
  recordAttempt(tenantId: string, rowId: string, attempt: DeliveryAttempt): Promise<boolean>;
  advance(tenantId: string, rowId: string, update: DispatchAdvanceUpdate): Promise<boolean>;
  dueRetries(
    tenantId: string,
    now: Date,
    onUnreadable: UnreadableRowReporter,
    limit?: number,
  ): Promise<readonly DueRetry[]>;
  reconcile(tenantId: string, rowId: string, at: Date): Promise<unknown>;
  attemptedRecipients(tenantId: string, rowId: string): Promise<ReadonlySet<string>>;
  unsettledSending(tenantId: string, limit?: number): Promise<readonly string[]>;
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

export interface DigestStoreLike {
  openOrReuse(tenantId: string, batch: DigestBatch): Promise<DigestBatch>;
  addItem(
    tenantId: string,
    digestId: string,
    member: { readonly dispatchRowId: string; readonly recipientAddressSha256: string },
  ): Promise<DigestAddResult>;
}

/** Where the drain reads a tenant's quiet-hours + digest policy (its tenant settings document). */
export type NotificationPolicySource = (tenantId: string) => Promise<NotificationPolicy>;

export interface DeliveryDrainOptions {
  readonly store: DeliveryStoreLike;
  readonly resolver: RecipientResolverLike;
  readonly senders: SenderRegistry;
  readonly policySource?: NotificationPolicySource;
  readonly digests?: DigestStoreLike;
  readonly clock?: () => Date;
  readonly batchSize?: number;
  readonly sendTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly timer?: SendTimer;
  readonly onError?: (err: unknown, tenantId: string) => void;
  /**
   * Renders a dispatch's approved template for the providers. Absent, every provider sends its own
   * identifier-only notice, which is what every deployment did before this option existed.
   */
  readonly content?: DispatchContentSource;
  /**
   * Where a dispatch row the contract refuses is reported.
   *
   * **Required**, unlike `onError` beside it, and the asymmetry is the decision: an error already
   * reaches a human through `drainTenants`' per-tenant catch and stops that tenant's tick, while a
   * refused row is now *skipped* — so with no reporter it is a notification that will never be sent
   * and nothing in the deployment says so. A reporter defaulting to "drop it silently" is the defect
   * restated as a default (ADR-0364's addendum).
   */
  readonly onUnreadable: (row: UnreadableRow, tenantId: string) => void;
}

export interface DrainReport {
  readonly tenantId: string;
  readonly dispatches: number;
  readonly delivered: number;
  readonly failed: number;
  readonly suppressed: number;
  readonly retryScheduled: number;
  readonly retriesAttempted: number;
  readonly deferred: number;
  readonly batched: number;
  readonly dropped: number;
}

const SEND_NOW: ThrottleDecision = {
  action: "send_now",
  reason: "digest_summary_bypasses_quiet_hours",
  releaseAt: null,
};

export const QUIET_HOURS_DROP_ERROR_CODE = "quiet_hours_drop";
export const QUIET_HOURS_DEFER_ERROR_CODE = "quiet_hours_defer";

export interface MultiTenantDrainReport {
  readonly tenants: number;
  readonly reports: readonly DrainReport[];
  readonly dispatches: number;
  readonly delivered: number;
  readonly failed: number;
  readonly suppressed: number;
  readonly retryScheduled: number;
  readonly deferred: number;
  readonly batched: number;
  readonly dropped: number;
}

export const DEFAULT_DRAIN_BATCH_SIZE = 25;

/**
 * The channel decides what an "address" is; suppressions and preferences are keyed by it, and
 * `null` means this recipient cannot be reached on this channel at all.
 *
 * It answered the e-mail address for every channel but `in_app` and `push_mobile`, so an SMS or a
 * voice call was handed an e-mail address as its destination, and push was handed a user id —
 * which FCM refuses, and which ADR-0310's sender refuses before FCM sees it. A phone channel now
 * reads `meta.users.phone_e164`; push answers `null` because **no table in this platform holds a
 * device registration token**, so there is nothing a push could be addressed to until one exists;
 * a webhook is addressed to an endpoint and not to a person, so a person-audience has none.
 */
export function addressFor(
  channel: NotificationChannel,
  recipient: ResolvedRecipient,
): string | null {
  switch (channel) {
    case "in_app":
      return recipient.userId;
    case "email":
      return recipient.email;
    case "sms":
    case "voice_call":
      return recipient.phoneE164;
    case "push_mobile":
    case "webhook":
      return null;
  }
}

/** Recorded on the attempt for a recipient `addressFor` has no address for on the channel. */
export const RECIPIENT_UNADDRESSABLE_ERROR_CODE = "recipient_unaddressable";

/** Recorded on a retry's closing attempt when its recipient can no longer be sent to at all. */
export const RECIPIENT_NO_LONGER_SENDABLE_ERROR_CODE = "recipient_no_longer_sendable";

/**
 * What one due retry came to: `attempted` reached a send (or a throttle) and `settled` closed a
 * retry whose recipient can no longer be sent to, without calling a provider.
 */
type RetryOutcome =
  | { readonly kind: "attempted"; readonly attempt: DeliveryAttempt }
  | { readonly kind: "settled"; readonly attempt: DeliveryAttempt };

/**
 * The hash an unaddressable recipient's attempt is recorded under. Not a hash of an address,
 * because there is none: namespaced so it can never equal one, and stable per (channel, user) so a
 * re-drain of the same dispatch finds the attempt already on record.
 */
export function unaddressableRecipientHash(channel: NotificationChannel, userId: string): string {
  return sha256(`unaddressable:${channel}:${userId}`);
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

async function contentFor(
  opts: DeliveryDrainOptions,
  dispatch: NotificationDispatch,
): Promise<DispatchContent | null> {
  if (opts.content === undefined) return null;
  try {
    const resolution = await opts.content(dispatch);
    return resolution.kind === "rendered" ? resolution.content : null;
  } catch {
    // A rendering failure costs the template, never the notice: the provider's default is sent.
    return null;
  }
}

async function sendOnce(
  opts: DeliveryDrainOptions,
  dispatch: NotificationDispatch,
  recipientAddress: string,
  attemptNumber: number,
  content: DispatchContent | null,
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
      content,
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

async function policyFor(
  opts: DeliveryDrainOptions,
  tenantId: string,
): Promise<NotificationPolicy> {
  if (opts.policySource === undefined) return DEFAULT_NOTIFICATION_POLICY;
  try {
    return await opts.policySource(tenantId);
  } catch {
    // An unreadable settings document must not stop the queue: no policy means send now.
    return DEFAULT_NOTIFICATION_POLICY;
  }
}

/**
 * A quiet-hours defer needs no new column or mechanism: `deferred` is already a retryable
 * delivery outcome, so recording one with `nextRetryAt` set to the release instant puts the
 * notice back through the existing retry ladder at exactly the right time.
 */
function throttledAttempt(
  dispatch: NotificationDispatch,
  recipientAddressSha256: string,
  attemptNumber: number,
  provider: ProviderKind,
  decision: ThrottleDecision,
  releaseAt: string | null,
  at: string,
): DeliveryAttempt {
  if (decision.action === "drop") {
    return buildDeliveryAttempt({
      dispatch,
      recipientAddressSha256,
      attemptNumber,
      outcome: "dropped",
      provider,
      sentAt: null,
      finalizedAt: at,
      errorCode: QUIET_HOURS_DROP_ERROR_CODE,
      errorMessage: decision.reason,
    });
  }
  return buildDeliveryAttempt({
    dispatch,
    recipientAddressSha256,
    attemptNumber,
    outcome: "deferred",
    provider,
    sentAt: null,
    finalizedAt: at,
    errorCode: QUIET_HOURS_DEFER_ERROR_CODE,
    errorMessage: decision.reason,
    nextRetryAt: releaseAt,
  });
}

/**
 * Pools one recipient's notice into their digest for the current window and returns when that
 * window releases, so every notice batched in it goes out together. Degrades to the plain
 * quiet-hours release when no digest store is wired or the frequency is not batchable.
 */
async function batchRelease(
  opts: DeliveryDrainOptions,
  tenantId: string,
  dispatch: NotificationDispatch,
  policy: NotificationPolicy,
  userId: string,
  decision: ThrottleDecision,
  now: Date,
  member: { readonly dispatchRowId: string; readonly recipientAddressSha256: string },
): Promise<string | null> {
  if (!isBatchableFrequency(policy.digestFrequency)) return decision.releaseAt;
  // Align to the quantized window even with no digest store wired, so a degraded batch still
  // releases its notices together instead of scattering them across the hour.
  const window = digestWindowFor(policy.digestFrequency, now);
  if (opts.digests === undefined) return window.scheduledDispatchAt;
  try {
    const stored = await opts.digests.openOrReuse(
      tenantId,
      buildDigestBatch({
        tenantId,
        userId,
        channel: dispatch.channel,
        frequency: policy.digestFrequency,
        openedAt: window.windowStart,
        scheduledDispatchAt: window.scheduledDispatchAt,
        maxItems: policy.digestMaxItems,
      }),
    );
    await opts.digests.addItem(tenantId, stored.id, member);
    return stored.scheduledDispatchAt;
  } catch (err) {
    opts.onError?.(err, tenantId);
    return window.scheduledDispatchAt;
  }
}

async function drainDispatch(
  opts: DeliveryDrainOptions,
  tenantId: string,
  claimed: ClaimedDispatch,
): Promise<{
  attempts: readonly DeliveryAttempt[];
  suppressed: number;
  retryScheduled: number;
  deferred: number;
  batched: number;
  dropped: number;
}> {
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

  // A dispatch still `rendering` was taken again after its claim lapsed: the drain that held it
  // may have sent to some recipients before it died, and their attempts are on record.
  const reclaimed = dispatch.status === "rendering";
  const alreadyAttempted = reclaimed
    ? await opts.store.attemptedRecipients(tenantId, claimed.rowId)
    : new Set<string>();

  const recipients: DrainRecipient[] = [];
  const unaddressable: string[] = [];
  for (const r of resolved) {
    const address = addressFor(dispatch.channel, r);
    if (address === null) {
      unaddressable.push(r.userId);
      continue;
    }
    recipients.push({
      userId: r.userId,
      address,
      preferences: preferences.get(r.userId) ?? emptyPreferenceMatrix(tenantId, r.userId, now()),
    });
  }

  const plan = planDelivery({ dispatch, recipients, suppressions, now: now() });
  const provider = providerFor(opts.senders, dispatch.channel);
  const attempts: DeliveryAttempt[] = [];
  // Each attempt is written as soon as it exists rather than after the whole fan-out, so a process
  // that dies part-way leaves a record of exactly who was already sent to.
  const record = async (attempt: DeliveryAttempt): Promise<void> => {
    attempts.push(attempt);
    await opts.store.recordAttempt(tenantId, claimed.rowId, attempt);
  };

  for (const userId of [...new Set(unaddressable)]) {
    const hash = unaddressableRecipientHash(dispatch.channel, userId);
    if (alreadyAttempted.has(hash)) continue;
    const at = now().toISOString();
    await record(
      buildDeliveryAttempt({
        dispatch,
        recipientAddressSha256: hash,
        attemptNumber: 1,
        outcome: "dropped",
        provider,
        sentAt: null,
        finalizedAt: at,
        errorCode: RECIPIENT_UNADDRESSABLE_ERROR_CODE,
        errorMessage: `recipient has no ${dispatch.channel} address`,
      }),
    );
  }

  for (const ineligible of plan.ineligible) {
    if (alreadyAttempted.has(ineligible.recipientAddressSha256)) continue;
    const at = now().toISOString();
    await record(
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

  // Quiet hours is a tenant policy over the dispatch's own category + priority, so the action is
  // the same for every recipient; only a digest pool is per-user.
  const policy = await policyFor(opts, tenantId);
  const decision = isDigestSummary(dispatch)
    ? SEND_NOW
    : decideThrottle({
        policy,
        category: dispatch.category,
        priority: dispatch.priority,
        now: now(),
      });

  let deferred = 0;
  let batched = 0;
  let dropped = 0;
  // Resolved at the first send, once per dispatch: every recipient gets the same template.
  let content: { readonly value: DispatchContent | null } | undefined;

  for (const target of plan.deliverable) {
    if (alreadyAttempted.has(target.recipientAddressSha256)) continue;
    if (decision.action !== "send_now") {
      const releaseAt =
        decision.action === "batch"
          ? await batchRelease(
              opts,
              tenantId,
              dispatch,
              policy,
              target.recipient.userId,
              decision,
              now(),
              {
                dispatchRowId: claimed.rowId,
                recipientAddressSha256: target.recipientAddressSha256,
              },
            )
          : decision.releaseAt;
      await record(
        throttledAttempt(
          dispatch,
          target.recipientAddressSha256,
          1,
          provider,
          decision,
          releaseAt,
          now().toISOString(),
        ),
      );
      if (decision.action === "drop") dropped += 1;
      else if (decision.action === "batch") batched += 1;
      else deferred += 1;
      continue;
    }
    const sentAt = now().toISOString();
    content ??= { value: await contentFor(opts, dispatch) };
    const result = await sendOnce(opts, dispatch, target.recipient.address, 1, content.value);
    await record(
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

  if (reclaimed) {
    // The attempts in hand are not all of this dispatch's attempts, so the counters are recomputed
    // from what is on record rather than from this pass.
    await opts.store.reconcile(tenantId, claimed.rowId, now());
    return {
      attempts,
      suppressed: attempts.filter((a) => a.outcome === "suppressed").length,
      retryScheduled: attempts.filter((a) => a.nextRetryAt !== null).length,
      deferred,
      batched,
      dropped,
    };
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
    deferred,
    batched,
    dropped,
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
): Promise<RetryOutcome> {
  const now = opts.clock ?? ((): Date => new Date());
  const dispatch = due.dispatch;
  const resolved = await opts.resolver.resolveAudience(tenantId, dispatch.audienceJson);
  const recipients: DrainRecipient[] = [];
  for (const r of resolved) {
    const address = addressFor(dispatch.channel, r);
    if (address === null) continue;
    recipients.push({ userId: r.userId, address, preferences: emptyPreferenceMatrix(tenantId, r.userId, now()) });
  }
  const suppressions = await opts.resolver.activeSuppressions(tenantId, dispatch.channel, now());
  const plan = planDelivery({ dispatch, recipients, suppressions, now: now() });
  const target = plan.deliverable.find(
    (p) => p.recipientAddressSha256 === due.recipientAddressSha256,
  );
  const attemptNumber = due.attemptNumber + 1;
  if (target === undefined) {
    // The recipient is no longer sendable to: suppressed since the first attempt, gone from the
    // audience, or without an address on this channel. Skipping it recorded nothing, so its attempt
    // stayed the latest and stayed retryable — the parent never settled, and with `dueRetries`
    // leasing the row it came back once a lease for ever. A terminal attempt settles it.
    const ineligible = plan.ineligible.find(
      (p) => p.recipientAddressSha256 === due.recipientAddressSha256,
    );
    const at = now().toISOString();
    const settled = buildDeliveryAttempt({
      dispatch,
      recipientAddressSha256: due.recipientAddressSha256,
      attemptNumber,
      outcome: ineligible !== undefined ? "suppressed" : "dropped",
      provider: providerFor(opts.senders, dispatch.channel),
      sentAt: null,
      finalizedAt: at,
      ...(ineligible !== undefined
        ? { errorMessage: ineligible.eligibility.reason }
        : {
            errorCode: RECIPIENT_NO_LONGER_SENDABLE_ERROR_CODE,
            errorMessage: `recipient is no longer in the audience or has no ${dispatch.channel} address`,
          }),
    });
    await opts.store.recordAttempt(tenantId, due.rowId, settled);
    return { kind: "settled", attempt: settled };
  }

  // A retry landing back inside quiet hours must defer again, not slip through the window the
  // first pass respected.
  const policy = await policyFor(opts, tenantId);
  const decision = isDigestSummary(dispatch)
    ? SEND_NOW
    : decideThrottle({
        policy,
        category: dispatch.category,
        priority: dispatch.priority,
        now: now(),
      });
  if (decision.action !== "send_now") {
    const releaseAt =
      decision.action === "batch"
        ? await batchRelease(opts, tenantId, dispatch, policy, target.recipient.userId, decision, now(), {
            dispatchRowId: due.rowId,
            recipientAddressSha256: due.recipientAddressSha256,
          })
        : decision.releaseAt;
    const throttled = throttledAttempt(
      dispatch,
      due.recipientAddressSha256,
      attemptNumber,
      providerFor(opts.senders, dispatch.channel),
      decision,
      releaseAt,
      now().toISOString(),
    );
    await opts.store.recordAttempt(tenantId, due.rowId, throttled);
    return { kind: "attempted", attempt: throttled };
  }

  const sentAt = now().toISOString();
  const result = await sendOnce(
    opts,
    dispatch,
    target.recipient.address,
    attemptNumber,
    await contentFor(opts, dispatch),
  );
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
  return { kind: "attempted", attempt };
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
  let deferred = 0;
  let batched = 0;
  let dropped = 0;

  const claimed = await opts.store.claimQueued(
    tenantId,
    (row) => opts.onUnreadable(row, tenantId),
    batch,
  );
  for (const one of claimed) {
    const result = await drainDispatch(opts, tenantId, one);
    for (const a of result.attempts) {
      if (a.outcome === "delivered") delivered += 1;
      else if (a.outcome !== "suppressed" && a.nextRetryAt === null) failed += 1;
    }
    suppressed += result.suppressed;
    retryScheduled += result.retryScheduled;
    deferred += result.deferred;
    batched += result.batched;
    dropped += result.dropped;
  }

  const due = await opts.store.dueRetries(
    tenantId,
    now(),
    (row) => opts.onUnreadable(row, tenantId),
    batch,
  );
  for (const one of due) {
    const outcome = await drainRetry(opts, tenantId, one);
    const attempt = outcome.attempt;
    if (outcome.kind === "settled") {
      if (attempt.outcome === "suppressed") suppressed += 1;
      else dropped += 1;
    } else {
      retriesAttempted += 1;
      if (attempt.outcome === "delivered") delivered += 1;
      else if (attempt.nextRetryAt !== null) retryScheduled += 1;
      else failed += 1;
    }
    // Nothing settled the parent before, so a dispatch whose retry delivered stayed `sending` and
    // its retries stayed selectable.
    await opts.store.reconcile(tenantId, one.rowId, now());
  }

  // A `sending` dispatch with nothing left pending — a process that died between a retry's attempt
  // and its reconcile leaves one — is settled here, so no dispatch can be stranded mid-send.
  for (const rowId of await opts.store.unsettledSending(tenantId, batch)) {
    await opts.store.reconcile(tenantId, rowId, now());
  }

  return {
    tenantId,
    dispatches: claimed.length,
    delivered,
    failed,
    suppressed,
    retryScheduled,
    retriesAttempted,
    deferred,
    batched,
    dropped,
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
    deferred: reports.reduce((n, r) => n + r.deferred, 0),
    batched: reports.reduce((n, r) => n + r.batched, 0),
    dropped: reports.reduce((n, r) => n + r.dropped, 0),
  };
}
