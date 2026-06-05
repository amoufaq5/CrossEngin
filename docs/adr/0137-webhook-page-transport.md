# ADR-0137: webhook page transport (Phase 3 P2.28)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0129 (re-page on escalation / PageDeliverer seam), ADR-0116 (incident bridge), ADR-0053 (Anthropic client — FetchLike injection pattern), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.28).

## Context

P2.20 (ADR-0129) added the `PageDeliverer` transport seam and a
`LoggingPageDeliverer` default, and wired `run()` to deliver page directives on
declaration + escalation — but the only implementation logged. A real outage
still didn't *page* anyone; the seam was waiting for a concrete transport.
P2.28 ships one.

## Decision

- **`WebhookPageDeliverer` (in `page-sink.ts`)** — a real transport that POSTs a
  normalized `PagePayload` as JSON to an operator-configured webhook URL. The
  payload (`pagePayload`, pure) is transport-neutral —
  `{ incidentId, severity, alertSeverity, reason: declared|escalated, channels,
  deliveredAt }` — so the same deliverer fits a PagerDuty Events API endpoint, a
  Slack incoming webhook, an Opsgenie webhook, or any HTTP sink (the receiver
  maps it to its own schema). On a non-2xx response or network error it **throws**,
  so the caller's `onError` routes a failed page (the incident is already
  persisted by then).
- **Zero runtime deps, injectable.** It uses the global `fetch` behind a minimal
  `FetchLike` seam (the same injection pattern as the Anthropic/OpenAI clients),
  so tests drive it with a fake and CI stays offline; `headers` (e.g. an auth
  token) merge onto `content-type: application/json`; `now` is injectable for the
  `deliveredAt` stamp.
- **`--page-webhook-url <url>`** — a new worker flag. When set, `run()` builds a
  `WebhookPageDeliverer` (over the global fetch); otherwise the
  `LoggingPageDeliverer` default. No other wiring changes — it's a drop-in behind
  the `PageDeliverer` seam, delivered on both declaration and escalation exactly
  as before.

## Cross-cutting invariants enforced (by tests)

- **`pagePayload`** builds the normalized body (incident / severities / reason /
  channels / deliveredAt).
- **`WebhookPageDeliverer`** POSTs the JSON to the configured URL with merged
  headers (`content-type` + any extra), throws on a non-2xx
  (`onError`-routable), and delivers every directive via `deliverPages`.
- **Real-network smoke.** Against a local `http` server, `deliver` issued a real
  `POST … content-type: application/json` carrying the payload JSON — proving the
  global-`fetch` wiring, not just the injected fake.

## Alternatives considered

- **A vendor SDK (PagerDuty / Opsgenie client).**
  - **Decision.** No — consistent with the rest of the platform (no vendor SDKs;
    the LLM clients are hand-rolled `fetch`), a generic webhook POST is
    dependency-free and works with every provider's inbound-webhook / events
    endpoint. A vendor-specific payload shaper can layer on later behind the same
    `PageDeliverer`.
- **Swallow webhook failures (log + continue).**
  - **Decision.** No — throwing surfaces a failed page through the existing
    `onError` path (so a broken webhook is visible), and the incident is already
    persisted, so the throw can't lose the record. A future retry/queue can wrap
    the deliverer.
- **A second flag for headers/auth.**
  - **Decision.** Deferred — the constructor takes `headers`, but the CLI exposes
    only `--page-webhook-url` for now; an auth-header flag (or env) is a trivial
    follow-up when a provider needs it.

## Consequences

- **61 packages + 3 apps, 124 meta-schema tables, 6,604 offline tests + 27 gated
  real-Postgres integration tests** (16 worker + 11 serving; +4 offline; 0 new
  tables/columns/packages). A stale-worker outage can now **actually page on-call**
  — `workflow-worker --monitor --page-webhook-url <url>` POSTs each resolved page
  directive (at declaration and at the higher severity on escalation) to a real
  HTTP endpoint. The paging seam (P2.20) now has a working transport; the
  Logging default is unchanged for dev.
- **The heartbeat → incident loop reaches on-call for real** — write → detect →
  plan → **POST page** → run → persist → escalate → **re-POST** → resolve.
