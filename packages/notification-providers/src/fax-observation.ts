import type { SuppressionRecord } from "@crossengin/notifications";

import {
  MAX_SUPPRESSION_NOTES_LENGTH,
  planSuppression,
  type VoiceReachabilityObservation,
} from "./bounce-webhook.js";

/*
 * The state ADR-0310 said this needed, and ADR-0329 named the shape of: "closing it properly needs a
 * consecutive-`fax` count, i.e. state a pure module does not hold."
 *
 * It still does not hold it. What lives here is the *arithmetic* over state somebody else holds — a
 * pure specification of how a run of `fax` verdicts advances, restarts, resets and is deduplicated,
 * plus the threshold that turns a run into a suppression. The store that keeps the count performs
 * exactly this in one SQL statement, and a test pins the two against each other, so the rule is
 * stated once and the race-free implementation of it cannot drift from the readable one.
 *
 * ---------------------------------------------------------------------------
 * Why the count is what makes a suppression honest, and what it is still not
 * ---------------------------------------------------------------------------
 *
 * `AnsweredBy=fax` is a detector's guess from a few hundred milliseconds of audio. ADR-0302's rule is
 * that a safety record must never widen on an inference, and one sample is an inference. A run of
 * them is a different claim: three calls, each answered by a fax tone, none of them answered by a
 * person or a voicemail in between, all inside a week. Twilio's detection keys a `fax` verdict on
 * the CNG tone rather than on "sounds mechanical", so a false one is already unlikely and three
 * consecutive false ones with no intervening human answer is the event this threshold is priced
 * against.
 *
 * It is still not a carrier verdict, which is why three things hold at once and all three are
 * load-bearing:
 *
 *   1. **The suppression is opt-in.** `consecutiveThreshold: null` — the default — counts and never
 *      suppresses. This is `BounceWebhookOptions.transientSuppressionHours`' precedent exactly: the
 *      one reason in this module derived from an inference rather than from a provider's own verdict
 *      is the one a deployment has to ask for. Counting is always on where the store is wired,
 *      because the count is free and is the thing an operator can actually act on — the directory
 *      entry is wrong, and no suppression fixes that.
 *   2. **The blast radius is one channel.** `meta.notification_suppressions` is unique per (tenant,
 *      **channel**, address), so a `voice_call` row leaves the same number's SMS untouched, and a
 *      page deliberately travels outside suppressions altogether (ADR-0326). A wrong row costs this
 *      number's voice *notifications*; it does not cost the on-call rotation.
 *   3. **The run is a run, not a lifetime total.** See `applyFaxObservation`.
 *
 * ---------------------------------------------------------------------------
 * Why the row is permanent, which is the part that looks wrong
 * ---------------------------------------------------------------------------
 *
 * `hard_bounce`, with no expiry. The tempting shape is a bounded `soft_bounce_exceeded` — it even
 * reads correctly, since a threshold *was* crossed — and it is wrong here for a mechanical reason
 * rather than a philosophical one.
 *
 * `PostgresSuppressionStore` never updates: its only conflict action is `DO NOTHING`, because a
 * replayed signed body must not be able to extend a suppression (ADR-0302). And `suppressionIdFor`
 * commits to (tenant, channel, address, reason) and to nothing else, so the id of a fax row is
 * stable for the address forever. Put those together and a bounded row **cannot be renewed**: the
 * window lapses, the lapsed row keeps the id, and the next crossing inserts nothing. "Bounded" would
 * therefore mean *suppressed for thirty days and then never suppressible again* — which carries the
 * full risk of being wrong and keeps none of the benefit. Of the two honest options, permanent is
 * the one that does what it says.
 *
 * What makes permanent defensible is that being wrong is now **visible and addressable** rather than
 * silent: the observation row names the address, the run length, the window it was collected in and
 * the instant the threshold was crossed. Before this, a fax verdict produced a log line nobody
 * counts. A permanent row that an operator can see the evidence for is a better position than an
 * invisible one they cannot.
 */

/**
 * How long a run stays a run. Beyond it, an arriving verdict starts a new one.
 *
 * Seven days. A telephone number is reassigned, a desk phone is swapped for a fax, a fax is swapped
 * back; two `fax` verdicts four months apart are not evidence about the same device and calling them
 * "consecutive" is an artefact of nothing having happened in between. The figure is defensible rather
 * than derived: it is long enough that a weekly notification cadence can accumulate a run, and short
 * enough that a run cannot be assembled out of a year.
 */
export const DEFAULT_FAX_OBSERVATION_WINDOW_HOURS = 24 * 7;

/**
 * The smallest run this module will accept as a threshold.
 *
 * Two, not one. A threshold of one is "suppress on a single detector sample", which is precisely the
 * thing ADR-0302 forbids and this whole module exists to avoid — so it is refused at the boundary
 * rather than left as a number an operator could set and believe was supported.
 */
export const MIN_FAX_SUPPRESSION_THRESHOLD = 2;

/** What a deployment chooses. Both fields have an answer for "not configured". */
export interface FaxObservationPolicy {
  /**
   * Consecutive `fax` verdicts required before a suppression is planned. `null` means never: count,
   * report, suppress nothing.
   */
  readonly consecutiveThreshold: number | null;
  readonly windowHours?: number;
}

/** The stored run, as the counter holds it. */
export interface FaxObservationState {
  readonly consecutiveCount: number;
  /** When the run last advanced, ISO-8601. */
  readonly lastObservedAt: string;
  /** The `CallSid` the run last advanced on; the dedup key. */
  readonly lastCallSid: string | null;
}

export const FAX_OBSERVATION_DISPOSITIONS = [
  /** No run existed for this address. */
  "started",
  /** The run grew by one. */
  "advanced",
  /** A run existed but was older than the window, so this verdict begins a fresh one. */
  "restarted",
  /** This `CallSid` already advanced the run — a retried callback. The count does not move. */
  "duplicate",
] as const;
export type FaxObservationDisposition =
  (typeof FAX_OBSERVATION_DISPOSITIONS)[number];

export interface FaxObservationOutcome {
  readonly consecutiveCount: number;
  readonly disposition: FaxObservationDisposition;
}

/**
 * What one `fax_detected` does to the stored run. The specification the store's `ON CONFLICT … DO
 * UPDATE` implements.
 *
 * The three branches are checked in this order and the order is the decision:
 *
 *   1. **Duplicate first.** Twilio retries a callback that did not answer 2xx, and a fax callback
 *      answered 422 until this existed. Nothing else about a counter is idempotent — a suppression's
 *      id makes a replayed *bounce* plan the identical row, but a replayed *observation* is a second
 *      increment — so the same call must not be counted twice. Checked before the window so that a
 *      retry arriving after the window has lapsed is still a retry and not a fresh run of one.
 *   2. **Staleness second.** A run older than the window is not evidence about today's number, so
 *      this verdict *restarts* at one rather than extending it. This is a time-based relaxation of
 *      an input to a safety decision, which is the move ADR-0328 refused for a schema default and
 *      ADR-0330 for an estimator's high-water mark — and the asymmetry is the point: those decay in
 *      the direction that **admits** (a loosened ceiling lets a request through), this decays in the
 *      direction that **withholds** (a forgotten run does not suppress). Forgetting on silence is
 *      the fail-closed choice when the thing being remembered is the case for a block.
 *   3. **Advance otherwise.**
 *
 * It answers the question "what if the count sits at threshold minus one forever?" — it does not.
 * Either another verdict arrives inside the window and the run completes, or none does and the next
 * one starts over.
 */
export function applyFaxObservation(input: {
  readonly existing: FaxObservationState | null;
  readonly observedAt: Date;
  readonly callSid: string;
  readonly windowHours?: number;
}): FaxObservationOutcome {
  const existing = input.existing;
  if (existing === null) return { consecutiveCount: 1, disposition: "started" };
  if (existing.lastCallSid !== null && existing.lastCallSid === input.callSid) {
    return { consecutiveCount: existing.consecutiveCount, disposition: "duplicate" };
  }
  const windowMs = windowMsOf(input.windowHours);
  const last = Date.parse(existing.lastObservedAt);
  // A stored instant that does not parse is treated as stale rather than as "now". The run it
  // describes cannot be placed in time, and a run that cannot be placed is not evidence — the same
  // direction as every other branch here.
  const stale = Number.isNaN(last) || input.observedAt.getTime() - last > windowMs;
  if (stale) return { consecutiveCount: 1, disposition: "restarted" };
  return {
    consecutiveCount: existing.consecutiveCount + 1,
    disposition: "advanced",
  };
}

export function windowMsOf(windowHours: number | undefined): number {
  const hours =
    windowHours === undefined || !Number.isFinite(windowHours) || windowHours <= 0
      ? DEFAULT_FAX_OBSERVATION_WINDOW_HOURS
      : windowHours;
  return hours * 3_600_000;
}

/**
 * Whether a threshold is one this module will act on.
 *
 * Exported because the only useful place to refuse a bad one is where it is configured — a boot that
 * says "`--voice-fax-suppress-after 1` is not a supported threshold" is worth a great deal more than
 * a silent clamp, which would have a deployment believing it had asked for something it had not.
 */
export function isUsableFaxThreshold(value: number | null): boolean {
  return (
    value === null ||
    (Number.isInteger(value) && value >= MIN_FAX_SUPPRESSION_THRESHOLD)
  );
}

export const FAX_SUPPRESSION_NOTE_PREFIX = "twilio_voice fax_detected";

/**
 * Plans the suppression a completed run justifies, or null.
 *
 * Null for every reason there is: no threshold configured, a run short of it, a malformed threshold,
 * or a record the contract refuses. One return value for all of them because the caller's action is
 * the same in each case — write nothing — and a caller that has to distinguish "below threshold"
 * from "misconfigured" is reading the wrong thing; the configuration is refused where it is set.
 *
 * The note records the run and the window, so the row answers *why* on its own face without the
 * reader going to find the observation it came from. It names no `CallSid`: the call that completed
 * the run is provenance for the run, and the run is already summarised here.
 */
export function planFaxSuppression(input: {
  readonly tenantId: string;
  readonly observation: VoiceReachabilityObservation;
  readonly consecutiveCount: number;
  readonly policy: FaxObservationPolicy;
  readonly observedAt: Date;
}): SuppressionRecord | null {
  if (input.observation.signal !== "fax_detected") return null;
  const threshold = input.policy.consecutiveThreshold;
  if (threshold === null || !isUsableFaxThreshold(threshold)) return null;
  if (input.consecutiveCount < threshold) return null;
  const windowHours = windowMsOf(input.policy.windowHours) / 3_600_000;
  const notes = `${FAX_SUPPRESSION_NOTE_PREFIX}; consecutive=${String(
    input.consecutiveCount,
  )}; threshold=${String(threshold)}; window_hours=${String(windowHours)}`;
  return planSuppression({
    tenantId: input.tenantId,
    channel: input.observation.channel,
    // Already normalised by the recognizer; `planSuppression` normalises again, which is idempotent
    // by `normalizeRecipientAddress`'s own invariant and is what keeps the id honest.
    recipientAddress: input.observation.address,
    reason: "hard_bounce",
    appliedAt: input.observedAt,
    // Permanent, and `planSuppression` would force this to null regardless; passed explicitly so
    // the intent is in the call rather than only in the schema that enforces it.
    expiresAt: null,
    appliedBy: "provider:twilio_voice",
    notes: notes.slice(0, MAX_SUPPRESSION_NOTES_LENGTH),
  });
}
