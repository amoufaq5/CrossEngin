import type { FetchLike } from "./email-ses.js";

/*
 * `Retry-After`, read and obeyed within limits.
 *
 * ADR-0326 gave `PageDispatcher` a bounded retry and reclassified HTTP 429 from `rejected` to
 * `failed` precisely so a rate-limited page is tried again. It then ignored the one piece of
 * information the provider actually sent: PagerDuty's Events API and Slack's `chat.postMessage`
 * both answer 429 with `Retry-After`, so a provider saying "come back in ten seconds" was retried
 * at two and four — both inside the window it refuses — and the page was reported `failed` having
 * burnt its whole budget without ever reaching a moment it could succeed. A uniform retry is worse
 * than no retry there.
 *
 * Two rules shape the parser, and both are about not inventing an instruction.
 *
 * This file also owns the two other figures that bound how long a page may wait — the ceiling on a
 * single instruction and the ceiling on a whole retry's summed waiting — because all three answer the
 * same question against the same target (`SEVERITY_PROFILES.sev1.ackMinutes`, five minutes), and
 * three numbers with one argument behind them drift the moment they live in three places.
 */

/**
 * The longest wait a page will honour.
 *
 * This delay sits in front of a human who has not been woken yet, so it cannot be set by whatever
 * the provider feels like asking for. The platform's tightest acknowledgement target is five
 * minutes (`sev1`), and the dispatcher's whole default budget is three attempts two seconds apart —
 * so thirty seconds is already a tenth of the response target spent before the page leaves, which
 * is affordable once and not twice. Past this, reporting `failed` is the better answer: every
 * escalator either re-derives its finding on the next tick and pages again, or has a human reading
 * an `undelivered` line — both beat one HTTP call held open past the point where it is still a page.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/**
 * The longest a whole retry may spend *waiting*, summed across every gap between its attempts.
 *
 * The same figure as `MAX_RETRY_AFTER_MS`, and deliberately the same number rather than a coincidence:
 * a tenth of the `sev1` acknowledgement target, affordable once. ADR-0327 was willing to spend it on
 * a single instruction, so it is exactly the amount this platform has already decided a page may be
 * held for — and spending it twice over two gaps was never argued for, it was merely never bounded.
 *
 * It is a budget on waiting, not on attempts: a policy with a zero delay retries freely, because it
 * spends none of this. And it is the one field of a retry policy that defaults to **active**, because
 * a budget a caller has to opt into bounds nothing. Before it, `PAGE_RETRY_ATTEMPTS=10
 * PAGE_RETRY_DELAY_MS=60000` — both inside the ranges `pageRetryFromEnv` accepts — would have held a
 * `sev1` for nine minutes, past the point where anybody was still waiting to be woken by it.
 */
export const DEFAULT_PAGE_RETRY_BUDGET_MS = 30_000;

/**
 * The highest a caller may raise that budget to: a fifth of the acknowledgement target.
 *
 * Above this the retry is no longer spending its own slack, it is spending the window in which a
 * human was supposed to have answered — so a deployment that wants more is told no rather than
 * handed a page that arrives after the SLA it exists to protect.
 */
export const MAX_PAGE_RETRY_BUDGET_MS = 60_000;

/**
 * The budget a policy's `totalBudgetMs` actually means.
 *
 * Absent and unusable both read as the default, since a budget is a safety bound and the unsafe
 * direction for a bound is "unbounded". `0` is honoured as itself — a caller asking for no waiting at
 * all still gets its attempts, it just gets no gaps between them. `Infinity` is **not** treated as
 * unsaid: it is an ordering-valid request for as much as possible, so it clamps to the ceiling like
 * any other over-long figure, where `NaN` and a negative are not quantities and read as unsaid.
 */
export function pageRetryBudgetMs(configured: number | null | undefined): number {
  if (configured === null || configured === undefined || Number.isNaN(configured)) {
    return DEFAULT_PAGE_RETRY_BUDGET_MS;
  }
  if (configured < 0) return DEFAULT_PAGE_RETRY_BUDGET_MS;
  return Math.min(Math.trunc(configured), MAX_PAGE_RETRY_BUDGET_MS);
}

/** Lowercase, because a plain-`Record` test double cannot do `Headers`' case-insensitive lookup. */
export const RETRY_AFTER_HEADER = "retry-after";

/** The one member of a real `Response` the page senders need beyond `FetchLike`'s three. */
export interface ResponseHeadersLike {
  get(name: string): string | null;
}

/**
 * `FetchLike` with the response's headers exposed.
 *
 * Derived from `FetchLike` rather than restated so the two cannot drift, and `headers` is
 * **optional** so every existing injected `fetch` and test double in this repo still satisfies it —
 * a response that does not expose headers simply carries no instruction, which is the behaviour
 * these senders had before.
 */
export type PageFetchLike = (
  url: string,
  init: Parameters<FetchLike>[1],
) => Promise<Awaited<ReturnType<FetchLike>> & { readonly headers?: ResponseHeadersLike }>;

/** Anything that tried to be delta-seconds and failed: a sign, a decimal point, an exponent. */
const NUMERIC_SHAPED = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** RFC 9110 §10.2.3: `delay-seconds = 1*DIGIT`. Nothing else is one. */
const DELAY_SECONDS = /^\d+$/;

/**
 * The wait a `Retry-After` asks for, in milliseconds, or `null` when it asks for nothing.
 *
 * RFC 9110 §10.2.3 gives the field two forms and both are handled: delta-seconds, and an HTTP-date
 * from which the wait is `date - now`. `now` is injected so the date branch is testable without the
 * wall clock.
 *
 * `null` means **no instruction** and never 0: a 0 would read as "retry immediately", which is the
 * opposite of what a header we could not understand should buy a provider.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (header === null || header === undefined) return null;
  const raw = header.trim();
  if (raw.length === 0) return null;

  if (DELAY_SECONDS.test(raw)) {
    // An absurd number of digits overflows to Infinity, which the clamp answers as over-ceiling —
    // the right answer for a header asking us to hold a page for longer than we are willing to.
    return clampRetryAfter(Number(raw) * 1000);
  }
  // A fractional or signed delta is not delta-seconds per the grammar, and this guard has to come
  // before the date branch rather than after it: `Date.parse` invents a date for `-5`, `+5`, `1.5`
  // and `.5` (May 2001, as it happens), so falling through would turn a malformed delta into a
  // wait of several decades. Answer `null` rather than guessing which the provider meant.
  if (NUMERIC_SHAPED.test(raw)) return null;

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  // Floored at 0: a date already in the past means "now", not a negative wait.
  return clampRetryAfter(Math.max(0, at - now.getTime()));
}

/**
 * Whether a parsed wait is one this platform has decided not to follow.
 *
 * It takes the **parsed** value rather than the header because the dispatcher never sees the
 * header — the sender that read it reports a `retryAfterMs`, and carrying the raw text through
 * `PageSendResult` as well would be a wider contract for the same single answer.
 *
 * `>=`, not `>`, and that is the point of clamping rather than rejecting: an over-ceiling
 * instruction arrives *as* the ceiling, so it is indistinguishable from one exactly at it — which
 * is deliberate, because the answer for both is the same. We are not holding a page that long.
 */
export function retryAfterExceedsCeiling(ms: number | null | undefined): boolean {
  return ms !== null && ms !== undefined && ms >= MAX_RETRY_AFTER_MS;
}

/**
 * The instruction a page response carries, or `null`.
 *
 * Shared by all three HTTP page senders for the reason ADR-0326 made `classifyPageFailure` shared:
 * each of them had independently got the same retry rule wrong, so the rule lives in one place.
 * Here that rule is **only a retryable outcome carries one** — a `rejected` page is never retried,
 * so a `Retry-After` on one is noise that would otherwise be recorded as if it meant something.
 */
export function retryAfterFromResponse(
  response: { readonly headers?: ResponseHeadersLike },
  retryable: boolean,
  now?: Date,
): number | null {
  if (!retryable) return null;
  return parseRetryAfter(response.headers?.get(RETRY_AFTER_HEADER) ?? null, now);
}

function clampRetryAfter(ms: number): number {
  return Math.min(Math.trunc(ms), MAX_RETRY_AFTER_MS);
}
