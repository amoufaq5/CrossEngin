# ADR-0144: webhook page transport — auth headers + bounded retry (Phase 3 P2.35)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0137 (webhook page transport — original `WebhookPageDeliverer`), ADR-0129 (re-page on escalation / `PageDeliverer` seam), ADR-0116 (incident bridge), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.35).

## Context

P2.28 (ADR-0137) shipped `WebhookPageDeliverer` — a generic `fetch`-based POST
to an operator-configured webhook URL behind a `FetchLike` seam — and noted two
deferred items: (a) the CLI exposed only `--page-webhook-url`, with no
auth-header flag, and (b) a non-2xx response (or thrown network error) threw
immediately, so a momentary 503 / TCP blip lost a page even though the upstream
sink (PagerDuty/Slack/Opsgenie) would have accepted a retry seconds later.

For a real production paging path neither is acceptable: PagerDuty's Events API
requires a `PagerDuty-Token` (or `Authorization: Bearer`) header, Slack
incoming-webhooks accept a webhook URL alone but Opsgenie requires
`Authorization: GenieKey …`, and every one of these endpoints is subject to
intermittent 5xx that's expected to clear in seconds. P2.35 hardens the
transport on both fronts.

## Decision

- **Auth headers (repeatable CLI flag).** The constructor already accepted a
  `headers` record; the CLI now exposes it via a **repeatable**
  `--page-webhook-header <k:v>` (so multiple headers can stack — e.g. an
  authorization token *and* a `PagerDuty-Token`). `parseWebhookHeaderSpec`
  splits at the **first** `:` (values may contain `:`), trims both sides, and
  rejects an empty key. The parsed map is threaded through `node.ts`'s
  `run()` into `WebhookPageDeliverer({ url, headers })`, merged on top of
  `content-type: application/json` so the JSON body still negotiates correctly.

- **Bounded retry with exponential backoff + jitter.** A new
  `WebhookRetryConfig` (`{maxAttempts?, baseDelayMs?, maxDelayMs?}`, defaults
  `{4, 200, 5000}`) on `WebhookPageDelivererOptions`. On a **5xx** response or a
  **thrown network error**, the deliverer retries up to `maxAttempts` total
  attempts (one initial + N retries) with delays computed by
  `computeWebhookBackoffMs(attempt, config, random)` — `baseDelayMs * 2^(n-1)`
  capped at `maxDelayMs`, with full jitter in `[0.5, 1.0]` so N workers don't
  synchronize. A **4xx** is non-retryable (auth / config — won't recover within
  the budget) and throws immediately. After exhausting all retries, the final
  attempt's error is wrapped in a message that names the attempt count + the
  incident, so the caller's `onError` still sees a clear cause.

- **Injectable sleeper + RNG.** `sleepMs(ms): Promise<void>` (defaults to a
  `setTimeout` promise) and `random()` (defaults to `Math.random`) are
  injectable so tests run **fast** and deterministically — no real waits,
  fixed jitter — and CI stays offline.

- **CLI: `--page-webhook-max-attempts <n>`** sets the budget (default 4, min 1
  via the existing `intFlag` validator). `maxAttempts=1` disables retry,
  preserving the ADR-0137 "throws on first failure" behavior for callers that
  want it.

## Cross-cutting invariants enforced (by tests)

- **Custom headers + content-type both land on the POST.** `Authorization:
  Bearer t` + `PagerDuty-Token: pd-xyz` both appear on the request alongside
  `content-type: application/json`.
- **One 503 retry → 200 succeeds.** Exactly two `fetchImpl` calls, one
  `sleepMs` between them.
- **Gives up after `maxAttempts` 5xx with a clear error.**
  `failed after 3 attempts (…INC-2026-0001)`; exactly two sleeps between the
  three calls.
- **4xx is not retried.** A 401 throws *immediately* (`HTTP 401 …
  non-retryable`); zero sleeps. Same for 403.
- **Thrown network errors are retried.** Two `ECONNRESET` throws followed by a
  200 succeeds; the third call wins.
- **`maxAttempts=1` disables retry.** First 500 throws, no sleeps, no second
  call.
- **`computeWebhookBackoffMs` doubles per attempt, caps at `maxDelayMs`,
  jitters in `[0.5, 1.0]`.** Pure unit-testable.
- **Repeatable `--page-webhook-header` parses values containing `:`.**
  `authorization:Bearer abc:def` round-trips intact. A missing colon or empty
  key is a `CliUsageError`.

## Alternatives considered

- **A queue / outbox in front of the webhook (durable retry across crashes).**
  - **Decision.** No (deferred) — over-engineered for a paging seam where the
    incident is already persisted in `meta.incidents` and the monitor will
    re-evaluate on the next poll (so a missed page becomes a re-page on
    escalation or the next ongoing-stale tick). A bounded in-process retry
    catches the common case (PagerDuty 503 for 2 seconds); a durable queue
    layers on later behind the same `PageDeliverer`.
- **Retry on 4xx too (e.g. 429 throttling).**
  - **Decision.** No — 4xx in this context is auth/config (401/403) or invalid
    payload (400), neither of which clears within the retry budget. A
    429-specific handler (read `Retry-After`) is a worthwhile follow-up but
    out of scope.
- **A single `--page-webhook-auth` flag instead of repeatable
  `--page-webhook-header`.**
  - **Decision.** No — Slack/PagerDuty/Opsgenie don't agree on the auth
    header name, and several deployments need *multiple* headers (a token +
    a routing-key + a content-id). One generic, repeatable flag covers every
    sink with no per-vendor wiring.

## Consequences

- **`apps/workflow-worker` offline tests: 61 → 76** (+15: custom headers, one
  503 → 200, give-up after N 5xx, 401/403 non-retryable, thrown network
  retried, `maxAttempts=1` disables retry, retry config validation,
  `computeWebhookBackoffMs` shape, header-spec parsing, CLI repeated headers,
  CLI max-attempts, help-text new flags). No new packages, no new
  meta-schema tables.
- **The paging transport now survives a brief upstream blip and works against
  every real provider's auth scheme** — a default `--page-webhook-url
  https://events.pagerduty.com/v2/enqueue --page-webhook-header
  "Authorization:Token token=xyz"` is the complete production config. A 5xx
  storm still surfaces (after the budget is exhausted) via `onError`, so a
  permanent outage isn't silently swallowed.
