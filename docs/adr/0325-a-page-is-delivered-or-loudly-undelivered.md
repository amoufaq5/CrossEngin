# ADR-0325: A page is delivered, or it is loudly undelivered

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-03 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0288, ADR-0293, ADR-0294, ADR-0301, ADR-0302, ADR-0310, ADR-0324 |

## Context

Three places in this platform plan a `PageDirective` — the SLO enforcement loop (ADR-0293), the
audit-integrity escalator (ADR-0288) and the deletion-evidence escalator (ADR-0324). All three then
hand it to a sink that writes a line to **stderr**.

So the platform declares `sev1` incidents, records them durably, and *claims* to page; nothing leaves
the process. ADR-0324 recorded it as an open question and noted it was the second ADR to do so:

> A `PageDirective` is still only logged, here and in the integrity escalator. Nothing in the platform
> delivers one, so the page is a claim about intent.

For findings whose entire justification is that nothing else will notice them — a falsified Article 17
proof, a tampered audit chain — an alarm that reaches nobody is the weakest link in the chain of
custody the preceding nine ADRs built.

## Decision

**Pages are delivered over real transports, and a directive that nothing took is its own reported
outcome.** `PageDispatcher` fans a directive out across its channels; `notification-providers` gains
three page-native senders.

| Channel | Transport | Configuration |
|---|---|---|
| `pagerduty_phone`, `pagerduty_business_hours` | Events API v2 `POST /v2/enqueue` | **none** |
| `slack` | `chat.postMessage` | `PAGE_SLACK_BOT_TOKEN` |
| `webhook` | signed POST to the policy's URL | optional `PAGE_WEBHOOK_SECRET` |
| `email_digest`, `sms` | — | reported `unroutable` |

### A page is not a notification, and must not travel as one

The obvious shortcut is to route these through `notifications` and reuse `SesEmailSender` /
`TwilioSmsSender`. That stack exists to **withhold** delivery on the recipient's behalf — preferences,
suppressions and quiet hours each decide not to send — and a `sev1` page is precisely the thing none
of them may apply to. A page gets its own senders so that it *cannot acquire a reason not to arrive*.

That is why `email_digest` and `sms` are `unroutable` rather than adapted: not an oversight, a refusal
to put a page behind machinery designed to suppress things.

### A page carries no tenant data

`PageContent` is three fields: the incident id, the severity, and a `signal` label the **deployment**
declared. Nothing comes from the finding — a deletion-evidence detail names a tenant uuid and a
tombstone id; an audit-integrity one names a tenant's chain.

This is ADR-0310's rule on a different surface and for the same reason: a page leaves through a third
party's servers and arrives on a lock screen. PagerDuty's `custom_details` is the obvious place to put
the finding and is deliberately empty of it, because PagerDuty renders those into emails, SMS and
push. The responder looks the incident up; the page only has to wake them.

### PagerDuty needs no configuration, on purpose

The Events API authenticates on the `routing_key` in the body, and `AlertChannelTarget` already
carries it as `serviceKey`. So a deployment that writes a PagerDuty route into its alert policy pages
correctly with **no environment at all** — which is the configuration most likely to be right at the
moment it matters. `dedup_key` is the incident id, the provider-level mirror of ADR-0294's
once-per-episode rule: re-paging one incident updates one PagerDuty alert instead of opening a second.

### Credentials from the environment, never argv

`PAGE_SLACK_BOT_TOKEN` and `PAGE_WEBHOOK_SECRET` resolve from the environment, following
`delivery-senders-env.ts` (ADR-0301): a process's argv is readable by anyone who can run `ps`.
Endpoint overrides exist for the same reasons the notification senders have them — a VPC endpoint, an
egress proxy, or a staging deployment that must not page the real rotation.

### Five dispositions, because "nothing happened" has several causes

`delivered` / `rejected` / `failed` / `unroutable` / `no_address`. `rejected` and `failed` are
separated because retrying may fix the second and never the first; `unroutable` (no sender wired for a
kind the policy names) and `no_address` (a policy target carrying no address) are separated from both,
because the thing to fix is the deployment, not the provider.

**Nothing is silently skipped.** ADR-0301's rule that a partially-configured provider is skipped
rather than guessed is about *notifications*, where not sending is the safe direction. For a page it
is the failure, so an unwired channel is reported.

### Every channel is attempted, and the failure is not thrown

A sender that throws is caught per channel, so one dead provider cannot stop the others from being
tried. `delivered === 0` with channels present is `undelivered` — logged at **error**, while a
successful page logs at info.

It is deliberately **not** thrown. By the time a page is planned the incident record is already
durable; raising here would make a successful declaration look like a failed escalation, which is the
same mistake ADR-0320 avoided by reporting `tenantRetired: false` on a 200.

## Alternatives considered

- **Option A:** adapt `SesEmailSender` / `TwilioSmsSender` so every alert channel has a transport.
  - **Pros:** complete coverage; two senders already written and tested.
  - **Cons:** they take a `SendRequest` — a *notification* with a template id, a recipient and a
    dispatch record — and the stack around them exists to withhold delivery. A page routed through it
    acquires preferences, suppressions and quiet hours.
  - **Why not:** the coverage is not worth making a `sev1` suppressible. A deployment that wants SMS
    paging supplies a `PageChannelSender`, and the gap is reported until it does.

- **Option B:** put the finding in the page so a responder sees what happened.
  - **Pros:** faster triage; no lookup.
  - **Cons:** the finding names a tenant and a tombstone, and the page renders on a lock screen via
    PagerDuty, Slack and a carrier. ADR-0310 already settled this for push.
  - **Why not:** the incident record holds the detail and is access-controlled. The page is a doorbell.

- **Option C:** throw when a page cannot be delivered, so the escalation fails loudly.
  - **Pros:** impossible to ignore.
  - **Cons:** the incident is already declared and stored. A throw would roll the *reporting* of a
    successful escalation into a failure, and in the scheduler's case be swallowed by the tick's
    `catch` anyway — louder in form, quieter in effect.
  - **Why not:** `undelivered` plus an error-level log says the same thing without lying about what
    succeeded.

- **Option D:** a Slack incoming-webhook URL instead of a bot token.
  - **Pros:** no token to manage; a URL is per-channel and self-authenticating.
  - **Cons:** an incoming webhook is bound to one channel at creation, so it cannot honour the policy's
    `channel` field — the policy would be decoration.
  - **Why not:** the alert policy chooses the channel, so the transport has to be able to obey it.

- **Option E:** retry a failed page inside the dispatcher.
  - **Pros:** a transient 503 would not lose the page.
  - **Cons:** the escalators have different retry shapes — the SLO loop and the deletion reconciler
    re-derive their finding every tick and would re-page anyway, while the integrity escalator is
    one-shot. A retry policy inside the dispatcher would double the first two.
  - **Why not:** the dispatcher reports; the caller already knows its own cadence. Worth revisiting
    only for the one-shot caller.

## Consequences

- **Positive:** every `sev1` this platform declares can now actually reach a human, over three real
  transports, with a payload that carries no tenant data. The two escalators share one dispatcher, so
  paging behaves identically whatever planned it.
- **Negative:** `email_digest` and `sms` are unroutable. A deployment whose alert policy names them
  gets `undelivered` until it supplies senders — correct and visible, but it is a gap, and the
  senders that would fill it exist a package away.
- **Negative:** nothing retries a failed page. For the integrity escalator — one-shot by design — a
  transport outage at the wrong moment means the incident is recorded and never announced. The error
  log is the only trace.
- **Neutral:** the SLO enforcement loop still logs rather than pages. Its sink is wired elsewhere in
  `node.ts` and converting it is a separate change; the dispatcher is ready for it.
- **Neutral:** a page is not recorded anywhere durable — not in `meta.audit_log`, not on the incident
  timeline. The report is a log line, which is better than the claim it replaces but is not evidence.
- **Reversibility:** PagerDuty aside, every transport is opt-in by environment, and an absent one is
  reported rather than assumed.

## Implementation notes

- `packages/notification-providers/src/page-pagerduty.ts`, `page-slack.ts` (Slack + signed webhook),
  `page-dispatch.ts`; `apps/operate-server/src/page-senders-env.ts` builds them and `node.ts` gives
  both escalators a dispatcher differing only in the `signal` label.
- Slack answers **200 with `{"ok": false}`** for an application error, so the HTTP status alone would
  report a page as delivered that Slack dropped. `slackOk` parses the body; a test pins it.
- The webhook signs `timestamp.body` with the platform's existing HMAC scheme (ADR-0302,
  `workflow-signal-bridge`), so a deployment has one signature format to verify. A secret too short to
  sign with is refused **at construction**, and `buildPageSendersFromEnv` then leaves the transport
  unwired rather than silently unsigned — a receiver expecting a signature would reject every page
  anyway, and dropping to unsigned is a downgrade nobody asked for.
- Verified live against the real server with a stand-in receiver on :9099. A tampered tombstone's
  escalation delivered **all three** transports: PagerDuty got `routing_key` from the policy,
  `dedup_key: INC-2026-0001` and `severity: critical`; Slack got `Bearer` + the policy's channel;
  the webhook got a signature **independently recomputed and matched** in Python against
  `timestamp.body`. Every body was checked for tenant data and contained none — no tenant uuid, no
  `tomb_` id, no defect name — and the server logged `PAGE INC-2026-0001 delivered=3/3`.
  With the receiver killed, the next escalation logged `PAGE UNDELIVERED INC-2026-0002` with
  `failed (fetch failed)` per channel **and still declared the incident**. A short
  `PAGE_WEBHOOK_SECRET` produced `[paging] not wired: webhook (…at least 16 bytes)` at boot. The
  **integrity** escalator went through the same dispatcher on a genuinely compromised tenant chain —
  `[integrity-proof] PAGE UNDELIVERED INC-2026-0003 … paged=pagerduty_phone` — proving both escalators
  reach the new transports; the three-transport *delivery* was observed on the deletion path, which
  runs the identical dispatcher.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A page is not recorded durably — no `meta.audit_log` row, no incident-timeline note. "We paged at 03:14 and PagerDuty accepted it" is exactly the claim an incident review needs, and it currently lives in a log line. | amoufaq5 | _unscheduled_ |
| Nothing retries a failed page. The two re-deriving escalators re-page on their next pass; the integrity escalator is one-shot, so a transport outage means a recorded, unannounced compromise. | amoufaq5 | _unscheduled_ |
| `email_digest` and `sms` are unroutable, and the senders that could serve them are one package away — behind the deliberate decision that a page must not travel as a notification. A page-native SMS sender over Twilio is a small, separate increment. | amoufaq5 | _unscheduled_ |
| The SLO enforcement loop still logs its page rather than dispatching it, so two of the three planners now deliver and one does not. | amoufaq5 | _unscheduled_ |
| PagerDuty alerts are only ever *triggered*. `event_action: "resolve"` on the same `dedup_key` would close the alert when an escalator closes its incident (ADR-0324 already cancels on recovery), and nothing sends it. | amoufaq5 | _unscheduled_ |

## References

- ADR-0324 (the open question this closes, recorded there and in ADR-0288 before it), ADR-0288
  ("escalation with nowhere to page is not escalation" — the rule this finally makes true), ADR-0310
  (a payload crossing a third party carries no tenant data), ADR-0301 (credentials from the
  environment, not argv; and why *skipping* is right for notifications and wrong here), ADR-0302 (the
  HMAC scheme reused for the webhook), ADR-0294 (once per episode, mirrored in `dedup_key`).
- PagerDuty Events API v2; Slack `chat.postMessage`.
