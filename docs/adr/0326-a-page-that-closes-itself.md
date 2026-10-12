# ADR-0326: A page that closes itself, retries itself, and leaves a record

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-03 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0286, ADR-0288, ADR-0293, ADR-0294, ADR-0296, ADR-0301, ADR-0310, ADR-0313, ADR-0323, ADR-0324, ADR-0325 |

## Context

ADR-0325 gave this platform real paging: `PageDispatcher` over PagerDuty's Events API, Slack's
`chat.postMessage` and a signed webhook, with five dispositions and `undelivered` reported rather
than thrown. It closed the gap it set out to close — a page that genuinely leaves the process — and
it ended with a list of things it had deliberately not done. Together with ADR-0324's four, that list
described a paging path which could wake somebody once and then had nothing more to say:

- **A PagerDuty alert was only ever *triggered*.** `event_action: "resolve"` on the same `dedup_key`
  would close it when an escalator cancels its incident, and nothing sent it. So every recovery left
  an alert on the board, and the board filled up with alerts for findings that had been put right —
  which is how a rotation learns to ignore the board.
- **Nothing retried a failed page.** Survivable for the two escalators that re-derive their finding
  every tick; not survivable for the integrity escalator, whose compromise finding is one-shot. It
  declares once, pages once, and the next pass reports `ongoing` and deliberately does *not* page
  again. For that one, a transport blip was the whole alarm.
- **A page was not recorded durably.** No `meta.audit_log` row, no incident-timeline note. "We paged
  at 03:14 and PagerDuty accepted it" lived only in a log line — which is exactly the claim an
  incident review needs, and exactly the artefact that has rotated away by the time the review
  happens.
- **`email_digest` and `sms` were `unroutable`,** by the deliberate decision that a page must not
  travel as a notification. Right for the digest; wrong for SMS, where the policy's own vocabulary
  has an `sms` channel and the only reason it could not be served was that nothing implemented it.
- **The SLO loop still "logged" its page.** It did not even do that: `EnforcementPlan.pages` has been
  built by both SLO engines since Phase 2 and read by **nothing**. `summarize` dropped the field, so
  a breach declared an incident, activated a kill switch, and planned a page that no code path ever
  touched. Two of three planners delivered; one silently discarded.
- **Every deletion-evidence finding was graded `sev1`,** which ADR-0324 named as its own first open
  question: an `unwitnessed` tombstone can plausibly be a row written outside the pipeline, while a
  rewritten scope cannot be anything but a tamper. Grading them alike was honest about the
  uncertainty and dishonest about the difference.
- **That escalation left no anchored row of its own.** `IntegrityEscalator` has written its
  escalation to `meta.audit_log` since ADR-0288, so the record of *why* a `sev1` was declared is
  committed to the forensic chain. The deletion-evidence escalator declared and paged in silence.
- **Nothing scheduled `auditCompleted`.** ADR-0323's reverse direction — a *completed* request whose
  stored proof no longer stands up — escalated only when a human loaded `GET .../unproven`. The
  finding the forensic chain structurally cannot raise was therefore raised only if somebody
  happened to look.

Separately, all three page senders classified HTTP **429** as `rejected`, which is in the
never-retried set. A rate limit is the most ordinary transient failure a paging provider produces,
and treating it as a decision meant giving up at the one moment the platform most needed to try
again.

## Decision

**A page is a two-sided fact, and both sides go over the transport and into the record.** Concretely:

1. **A recovery resolves the alert its declaration opened.** `PageChannelSender.resolve?` is optional
   — PagerDuty keys on `dedup_key` and can close an alert; a Slack message and a webhook POST cannot
   be unposted, and report the new `unsupported` disposition, which is not a failure.
   `PageDispatcher.resolve` fans out over the same channels as `deliver` through a shared `fanOut`.

2. **A resolve reaches exactly where its trigger did, or it closes nothing.** `AlertPolicy` maps a
   severity to a channel set, so the grade *is* the route. Each escalator answers "which grade" from
   the only source that can be right for it:
   - the **deletion-evidence** escalator reads `open.severity` off the record `findOpen` returned,
     because it grades per defect;
   - the **integrity** escalator uses `config.severity`, because it declares every compromise at one
     grade;
   - the **SLO** loop resolves over the directives it *actually delivered*, remembered per incident
     id, because a `recovered` decision carries no severity and no plan — there is nothing to
     re-plan from.

3. **A close-out that does not close the record does not close the alert.** `closeOutClosesAlert`
   lives beside `INCIDENT_CLOSE_OUTS` and answers for all four: `cancelled` and `unpersisted` yes,
   `human_owned` and `failed` no. One definition, three callers.

4. **Retry is on by default.** `PageRetryPolicy` is the dispatcher's, not the senders' — only the
   dispatcher sees the whole fan-out — and `failed` is the only retryable disposition. Three attempts
   two seconds apart, overridable by `PAGE_RETRY_ATTEMPTS` / `PAGE_RETRY_DELAY_MS`, with
   `attemptsMade` on every outcome. **429 is `failed`,** via one shared `classifyPageFailure` the
   three senders call.

5. **A delivery attempt is written to `meta.audit_log`,** under `platform.page_delivered` or
   `platform.page_undelivered` — two operations rather than one with a boolean, so "how often does
   our paging path fail" is a `countSince` with no payload parsing. The row carries the per-channel
   outcomes and **nothing** tenant-derived; the tenant is the row's scope, supplied by the caller,
   because a `PageDeliveryReport` deliberately carries none (ADR-0310, ADR-0325) and so a
   `tenantIdFor(report)` resolver has nothing to resolve *from*.

6. **An evidence finding is graded per defect,** highest wins, through `severityByDefect` keyed on the
   real `EVIDENCE_DEFECTS` enum — so a typo'd defect name is a parse error rather than an override
   that quietly never matches. The escalation and its recovery each leave an anchored
   `platform.deletion_evidence_escalated` / `_resolved` row carrying the incident id, the grade, the
   defects and the verdict.

7. **`sms` is a real page transport.** `SmsPageSender` is deliberately *not* the notification stack's
   Twilio sender and takes its own `PAGE_SMS_*` credentials: the notification stack exists to withhold
   delivery, and a page is the one thing none of that may apply to.

8. **The SLO loop delivers its pages,** awaited — unlike `onDecision`, which only observes — so a
   pass cannot report a breach handled before anybody was told.

9. **`auditCompleted` runs on a schedule,** every *n*th reconciliation tick
   (`--deletion-audit-every-ticks`), in its own `try`.

## Alternatives considered

- **Option A: resolve by re-planning the directive from the configured default severity.** What the
  first cut did.
  - **Pros:** one line; no need to read anything off the incident.
  - **Cons:** wrong for any incident not graded at the default — which per-defect grading had just
    made the common case. A `sev3` finding that paged the P2 route would be "resolved" at PagerDuty's
    P0 service, which never had an alert for it, while the rotation that *was* paged keeps a page
    nobody closed.
  - **Why not:** it fails in the direction that produces silence. Observed live before the fix: a
    `sev3` incident paged `live-routing-key-p2` and its resolve went to `live-routing-key-abc`.

- **Option B: have the SLO loop re-plan its resolve from the policy, like the escalators.**
  - **Pros:** no in-process memory; survives a restart.
  - **Cons:** there is nothing to plan *from*. The engines' `recovered` decision carries
    `incidentId`, `killSwitchId` and `closeOut` — no severity, because the breach is over. Re-planning
    means picking a grade, and picking one is Option A's defect with extra steps.
  - **Why not:** remembering what was delivered is the only answer that is *correct*; a restart that
    forgets resolves nothing and leaves the alert for a human, which is the fail-closed direction.

- **Option C: retry inside each sender.** Declined by ADR-0325 Option E and still declined.
  - **Pros:** the sender knows its own provider's retry semantics.
  - **Cons:** only the dispatcher sees the whole fan-out, so only it can bound the total latency in
    front of somebody waiting to be woken; and three senders would grow three retry loops.
  - **Why not:** the budget is a property of the page, not of a transport.

- **Option D: record the page on the `PageDeliveryReport`'s own tenant.** The first implementation
  took a `tenantIdFor(report)` resolver.
  - **Pros:** the recorder is self-contained; one call site.
  - **Cons:** the report carries no tenant **by design** — ADR-0310 and ADR-0325 kept tenant data out
    of a page because a push body renders on a lock screen and a page body reaches a provider. So the
    resolver could only ever consult a directory keyed on an incident id, and in this deployment there
    is none: it returned null every time and every page went unrecorded.
  - **Why not:** the escalator already holds the `IncidentRecord` it declared. It supplies the tenant;
    the resolver stays for a caller that genuinely has a directory.

- **Option E: one `platform.page` operation with a `delivered` boolean.**
  - **Pros:** one name to grep.
  - **Cons:** "who was woken, and when" and "why did nobody come" are different questions, and the
    second is the one a review runs a count over.
  - **Why not:** two operations make the failure directly countable.

- **Option F: grade an evidence finding by a single configurable severity, as before.**
  - **Pros:** nothing to configure; no map to get wrong.
  - **Cons:** `unwitnessed` and `scope_tampered` are not the same claim, and paging the same rotation
    for both trains that rotation to treat the stronger one as noise.
  - **Why not:** the gradation is the point. The map is partial, so an unnamed defect keeps the
    default and a deployment that does not care configures nothing.

- **Option G: resolve the alert on every close-out, including `human_owned`.**
  - **Pros:** simpler; the signal has recovered either way.
  - **Cons:** `human_owned` means the declarer *refused* to close the record because somebody triaged
    it. The incident is open and owned, and resolving its alert takes it off the board of the person
    holding it — telling the provider the opposite of what is true.
  - **Why not:** an alert left up is noise; an alert wrongly closed is silence.

## Consequences

- **Positive:** an alert's lifecycle now matches its incident's. Three escalators trigger and resolve
  over the same transports, with the same gate, and a resolve lands on the route its trigger used. A
  one-shot compromise finding survives a transient 502. A page is evidence, anchored into the
  forensic chain wherever the deployment has one. An evidence finding is graded by what is actually
  wrong with the record. The SLO loop's pages, planned since Phase 2, finally leave the process.
- **Negative:** the SLO resolve depends on in-process memory, so a restart between a breach and its
  recovery resolves nothing. Retry adds up to ~4s of worst-case latency to reach somebody. A page
  record cannot be written for a platform-scope incident at all, because `meta.audit_log.tenant_id`
  is NOT NULL — the same wall ADR-0313 and `IntegrityEscalator.record` already hit.
- **Neutral:** `PAGE_SMS_*` is a second set of Twilio credentials beside the notification stack's
  `TWILIO_*`. Deliberate: a deployment may well want pages to come from a different number than
  customer messages, and sharing the variables would make that inexpressible.
- **Reversibility:** every piece is additive and separately removable. `retry` defaults back to one
  attempt by passing `PAGE_RETRY_ATTEMPTS=1`; the resolve sinks are optional callbacks; the recorder
  is skipped without an audit emitter; `severityByDefect` is an optional field whose absence restores
  the previous single-grade behaviour byte for byte.

## Implementation notes

- `packages/notification-providers/src/page-pagerduty.ts` — `pagerDutyResolveBody` (three keys, no
  `payload`), `PagerDutyPageSender.resolve`, and `classifyPageFailure` / `PAGE_RATE_LIMIT_STATUS`,
  which `page-slack.ts`'s two senders also call.
- `packages/notification-providers/src/page-dispatch.ts` — `resolve?` on the sender contract,
  `"unsupported"` in `PAGE_CHANNEL_DISPOSITIONS`, `attemptsMade`, `PageRetryPolicy` + an injected
  `sleep`, `PageDispatcher.resolve`, and a private `fanOut(directive, operation)` shared by both.
  `undelivered` is now `asked > 0 && delivered === 0` where `asked` excludes `unsupported`, so an
  all-`unsupported` resolve is not a failed page.
- `packages/notification-providers/src/page-sms.ts` — `SmsPageSender`, `smsPageBody`,
  `MAX_PAGE_SMS_CHARACTERS = 160`. Refuses at construction on incomplete credentials or on neither /
  both sender identities, following ADR-0301's rule.
- `packages/incident-response-runtime/src/declarer.ts` — `closeOutClosesAlert`, beside the vocabulary
  it answers for.
- `apps/operate-server/src/page-record.ts` — `PageRecorder`, the two operations, and
  `record(report, suppliedTenantId?)`.
- `apps/operate-server/src/page-senders-env.ts` — `buildPageSendersFromEnv` /
  `buildPageDispatcher`, `DEFAULT_PAGE_RETRY`, `pageRetryFromEnv`.
- `apps/operate-server/src/deletion-evidence-escalation.ts` — `severityForDefects` (seeded `null`,
  not `config.severity`, so an override can grade *down*), the two audit operations, `resolvePage`.
- `apps/operate-server/src/slo.ts` — `pages` carried through `summarize`, awaited `onPage`, the
  `paged` map and `onResolvePage`.
- `apps/operate-server/src/node.ts` — three dispatchers, `deliverAndRecord` (which a **resolve** is
  deliberately not routed through: an all-`unsupported` resolve would land as
  `platform.page_undelivered`, claiming a page failed when none was sent), and the resolve sinks.

**Verified live** against a throwaway Postgres and the real server, with a recording endpoint
standing in for PagerDuty, Slack and Twilio:

- A `sev1` finding (`scope_tampered`, `scope_disagrees_with_attestations`) paged the P0 route; putting
  the scope back produced
  `{"routing_key":"live-routing-key-abc","event_action":"resolve","dedup_key":"INC-2026-0001"}`.
- Breaking the tombstone's chain witness produced `unwitnessed` → **`sev3`** →
  `{"routing_key":"live-routing-key-p2","event_action":"trigger","dedup_key":"INC-2026-0003"}`, and
  restoring it produced `{"routing_key":"live-routing-key-p2","event_action":"resolve",...}` — the
  **P2** key, not the default's. This is the defect in Option A, observed in both directions.
- `meta.audit_log` shows the recorded-grade defect as a before-and-after in one table:
  `INC-2026-0002` was escalated at `sev3` and its (pre-fix) `_resolved` row claims `sev1`;
  `INC-2026-0003`'s pair reads `sev3` / `sev3`.
- The SLO loop declared `INC-2026-0004` (sev2 → P1), paged `slo-key-p1`, and on recovery
  (`closeOut=cancelled`) sent `event_action: "resolve"` on the same key.
- The integrity escalator declared `INC-2026-0005`, paged `integ-key-p1`, and resolved it on the
  `verified` pass.
- Retry, against an endpoint answering 502, 502, 202: `attemptsMade: 3`, `delivered`, 432 ms with a
  200 ms delay.
- `platform.page_delivered` rows carry the per-channel outcomes including `attemptsMade`, and the SMS
  body — `CrossEngin SEV1 deletion-evidence INC-2026-0001` — carries nothing from the finding.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A page is recorded in `meta.audit_log` but leaves no incident-*timeline* note, so the incident record alone still does not say when it was paged. | amoufaq5 | 2026-11-30 |
| The SLO resolve's memory is in-process, so a restart mid-breach resolves nothing. An incident's declared severity would survive a restart — but reading it back means asking the store on every recovery. | amoufaq5 | 2026-12-31 |
| A platform-scope page cannot be recorded at all (`meta.audit_log.tenant_id` is NOT NULL). The SLO loop's pages are always in that position. | amoufaq5 | 2026-12-31 |
| Retry is uniform across channels; a provider with a `Retry-After` header is not honoured. | amoufaq5 | 2026-12-31 |
| `email_digest` remains `unroutable` by design. If a deployment has only email, it has no page at all and is told so once per page. | amoufaq5 | 2026-12-31 |
| Every deletion-evidence defect still pages *somebody*; there is no "record it and do not wake anyone" grade. | amoufaq5 | 2026-12-31 |

## References

- PagerDuty Events API v2 — `event_action` and `dedup_key` semantics.
- ADR-0325 (the transports and the five dispositions), ADR-0324 (one incident per request),
  ADR-0323 (the tamper the chain cannot see), ADR-0310 (a payload may not vary with content),
  ADR-0301 (a partially-configured provider is skipped, not guessed), ADR-0296 (write the thing
  before the row that names it), ADR-0294 (`autoDeclaredForKey`), ADR-0293 (the `IncidentDeclarer`
  seam), ADR-0288 (escalation leaves an anchored row), ADR-0286 (`appendWithin`).
