import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_RETRY_BUDGET_MS,
  MAX_PAGE_RETRY_BUDGET_MS,
  MAX_RETRY_AFTER_MS,
  RETRY_AFTER_HEADER,
  pageRetryBudgetMs,
  parseRetryAfter,
  retryAfterExceedsCeiling,
  retryAfterFromResponse,
} from "./retry-after.js";

/** The `sev1` acknowledgement target every figure in this file is argued against. */
const SEV1_ACK_MS = 5 * 60 * 1000;

/** A fixed `now`, so the HTTP-date branch never touches the wall clock. */
const NOW = new Date("2026-10-04T12:00:00.000Z");

/** A response exposing exactly the one header member the senders read. */
function withHeader(value: string | null): { readonly headers: { get(n: string): string | null } } {
  return { headers: { get: (n) => (n === RETRY_AFTER_HEADER ? value : null) } };
}

describe("delta-seconds", () => {
  it("reads a plain integer as seconds", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("1")).toBe(1000);
  });

  it("reads zero as zero, which is an instruction and not an absence", () => {
    // The dispatcher's `max(policy, provider)` is what keeps this from becoming a hot loop; the
    // parser's job is only to report what was said.
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("trims the surrounding whitespace a field value may carry", () => {
    expect(parseRetryAfter("  120  ")).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter("\t7\n")).toBe(7000);
  });

  it("refuses a fractional delta rather than rounding it", () => {
    // `1*DIGIT` per the grammar. And `Date.parse("1.5")` answers a date in 2001, so guessing here
    // would turn a malformed delta into a wait of decades.
    expect(parseRetryAfter("1.5")).toBeNull();
    expect(parseRetryAfter(".5")).toBeNull();
    expect(parseRetryAfter("10.")).toBeNull();
  });

  it("refuses a signed delta, which the date branch would otherwise invent a date for", () => {
    expect(parseRetryAfter("-5")).toBeNull();
    expect(parseRetryAfter("+5")).toBeNull();
  });

  it("refuses exponent notation", () => {
    expect(parseRetryAfter("1e3")).toBeNull();
    expect(parseRetryAfter("1E3")).toBeNull();
  });

  it("refuses digits with a unit attached", () => {
    expect(parseRetryAfter("5s")).toBeNull();
    expect(parseRetryAfter("5 seconds")).toBeNull();
  });

  it("answers the ceiling for a delta so large it overflows to Infinity", () => {
    // A valid `1*DIGIT` the platform will not honour, which is the same answer as any other
    // over-ceiling instruction: the ceiling, flagged as capped.
    expect(parseRetryAfter("1".repeat(400))).toBe(MAX_RETRY_AFTER_MS);
    expect(retryAfterExceedsCeiling(parseRetryAfter("1".repeat(400)))).toBe(true);
  });
});

describe("the HTTP-date form", () => {
  it("reads the wait as date minus the injected now", () => {
    expect(parseRetryAfter("Sun, 04 Oct 2026 12:00:10 GMT", NOW)).toBe(10_000);
  });

  it("answers zero for a date that is exactly now", () => {
    expect(parseRetryAfter("Sun, 04 Oct 2026 12:00:00 GMT", NOW)).toBe(0);
  });

  it("floors a date already past at zero, never a negative wait", () => {
    // "Come back at a time that has passed" means now, and a negative wait would be nonsense that
    // `max(policy, provider)` would silently absorb.
    expect(parseRetryAfter("Sun, 04 Oct 2026 11:59:00 GMT", NOW)).toBe(0);
    expect(parseRetryAfter("Wed, 21 Oct 2020 07:28:00 GMT", NOW)).toBe(0);
  });

  it("clamps a date far in the future to the ceiling", () => {
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT", NOW)).toBe(MAX_RETRY_AFTER_MS);
  });

  it("accepts the ISO spelling too, since it is still an instruction", () => {
    expect(parseRetryAfter("2026-10-04T12:00:08.000Z", NOW)).toBe(8000);
  });

  it("refuses a date it cannot parse", () => {
    expect(parseRetryAfter("not a date", NOW)).toBeNull();
    expect(parseRetryAfter("Someday, 32 Foo 2026 07:28:00 GMT", NOW)).toBeNull();
  });

  it("defaults now to the wall clock, so a caller need not supply one", () => {
    const soon = new Date(Date.now() + 4000).toUTCString();
    const ms = parseRetryAfter(soon);
    // Second granularity in the header plus elapsed time, so a range rather than a figure.
    expect(ms).not.toBeNull();
    expect(ms as number).toBeGreaterThan(2000);
    expect(ms as number).toBeLessThanOrEqual(4000);
  });
});

describe("no instruction", () => {
  it("answers null for a missing header, never zero", () => {
    // Zero would read as "retry immediately", which is the opposite of what a header we do not
    // have should buy a provider.
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });

  it("answers null for an empty or whitespace-only header", () => {
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("   ")).toBeNull();
    expect(parseRetryAfter("\t\n")).toBeNull();
  });

  it("answers null for the words a number-shaped header might carry", () => {
    expect(parseRetryAfter("Infinity")).toBeNull();
    expect(parseRetryAfter("NaN")).toBeNull();
  });
});

describe("the ceiling", () => {
  it("is short enough that a page is still a page after it", () => {
    // A tenth of the five-minute `sev1` acknowledgement target, spent once.
    expect(MAX_RETRY_AFTER_MS).toBe(30_000);
  });

  it("clamps rather than rejects, so the recorded figure says what was asked", () => {
    expect(parseRetryAfter("600")).toBe(MAX_RETRY_AFTER_MS);
  });

  it("reports an over-ceiling instruction as over-ceiling, not as a ceiling-long wait", () => {
    // Clamping alone would honour half of an instruction we have decided not to follow.
    expect(retryAfterExceedsCeiling(parseRetryAfter("600"))).toBe(true);
    expect(retryAfterExceedsCeiling(parseRetryAfter("5"))).toBe(false);
  });

  it("treats a value exactly at the ceiling as over it, deliberately", () => {
    // The clamp makes the two indistinguishable, and the answer for both is the same one.
    expect(retryAfterExceedsCeiling(MAX_RETRY_AFTER_MS)).toBe(true);
    expect(retryAfterExceedsCeiling(MAX_RETRY_AFTER_MS - 1)).toBe(false);
  });

  it("treats an absent instruction as not over the ceiling", () => {
    // Otherwise every response with no header would stop the retry ADR-0326 added.
    expect(retryAfterExceedsCeiling(null)).toBe(false);
    expect(retryAfterExceedsCeiling(undefined)).toBe(false);
    expect(retryAfterExceedsCeiling(0)).toBe(false);
  });
});

describe("the whole retry's budget", () => {
  it("is the same figure as the ceiling on one instruction, deliberately", () => {
    // ADR-0327 was already willing to spend 30s on a single `Retry-After`, so that is exactly the
    // amount this platform has decided a page may be held for. Spending it twice over two gaps was
    // never argued for — it was merely never bounded. One instruction may therefore consume the
    // whole budget, and nothing may consume more.
    expect(DEFAULT_PAGE_RETRY_BUDGET_MS).toBe(MAX_RETRY_AFTER_MS);
    expect(DEFAULT_PAGE_RETRY_BUDGET_MS).toBe(SEV1_ACK_MS / 10);
    expect(MAX_PAGE_RETRY_BUDGET_MS).toBe(SEV1_ACK_MS / 5);
  });

  it("reads an absent budget as the default, because unbounded is the unsafe direction", () => {
    expect(pageRetryBudgetMs(undefined)).toBe(DEFAULT_PAGE_RETRY_BUDGET_MS);
    expect(pageRetryBudgetMs(null)).toBe(DEFAULT_PAGE_RETRY_BUDGET_MS);
  });

  it("honours zero as itself, which is a caller asking for no waiting at all", () => {
    // Distinct from absent: it still permits attempts, it permits no gaps between them.
    expect(pageRetryBudgetMs(0)).toBe(0);
  });

  it("takes a figure it cannot use as not having been said", () => {
    expect(pageRetryBudgetMs(-1)).toBe(DEFAULT_PAGE_RETRY_BUDGET_MS);
    expect(pageRetryBudgetMs(Number.NaN)).toBe(DEFAULT_PAGE_RETRY_BUDGET_MS);
    expect(pageRetryBudgetMs(Number.POSITIVE_INFINITY)).toBe(MAX_PAGE_RETRY_BUDGET_MS);
  });

  it("keeps a usable figure, truncated", () => {
    expect(pageRetryBudgetMs(10_000)).toBe(10_000);
    expect(pageRetryBudgetMs(1500.7)).toBe(1500);
  });

  it("clamps a figure that would spend the acknowledgement window itself", () => {
    expect(pageRetryBudgetMs(600_000)).toBe(MAX_PAGE_RETRY_BUDGET_MS);
    expect(pageRetryBudgetMs(MAX_PAGE_RETRY_BUDGET_MS)).toBe(MAX_PAGE_RETRY_BUDGET_MS);
  });
});

describe("reading it off a response", () => {
  it("reads the header when the outcome is retryable", () => {
    expect(retryAfterFromResponse(withHeader("9"), true)).toBe(9000);
  });

  it("ignores the header when the outcome is not retryable", () => {
    // A `rejected` page is never retried, so a header on one is noise that would otherwise be
    // recorded as if it meant something.
    expect(retryAfterFromResponse(withHeader("9"), false)).toBeNull();
  });

  it("answers null for a response that exposes no headers at all", () => {
    // Which is every `FetchLike` double written before this existed: the behaviour must be exactly
    // what it was, not a zero-length wait.
    expect(retryAfterFromResponse({}, true)).toBeNull();
  });

  it("answers null when the response has headers but not this one", () => {
    expect(retryAfterFromResponse(withHeader(null), true)).toBeNull();
  });

  it("looks the header up under its lowercase name", () => {
    const seen: string[] = [];
    retryAfterFromResponse(
      {
        headers: {
          get: (n): string | null => {
            seen.push(n);
            return null;
          },
        },
      },
      true,
    );
    expect(seen).toEqual([RETRY_AFTER_HEADER]);
    expect(RETRY_AFTER_HEADER).toBe("retry-after");
  });

  it("passes the injected now through to the date branch", () => {
    expect(retryAfterFromResponse(withHeader("Sun, 04 Oct 2026 12:00:03 GMT"), true, NOW)).toBe(
      3000,
    );
  });
});
