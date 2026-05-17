# ADR-0039: Notifications and delivery

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-16 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0008 (audit), ADR-0011 (integration mesh), ADR-0017 (observability), ADR-0022 (i18n), ADR-0037 (incident response), ADR-0038 (SSO) |

## Context

By Phase 1 we have 33 packages producing audit-worthy events, but no unified contract for **outbound delivery to humans**: who gets notified, on which channel, with what content, under what rate limits, and with what suppression rules. Every package currently has language like "alert the admin" or "page on-call" in its design — that language needs a single home so we don't re-implement six half-correct notification subsystems.

Concrete drivers:

1. **SSO** wants to alert users on new-device logins, MFA setup, password resets, IdP test failures.
2. **incident-response** wants to page on-call, broadcast status-page updates, send breach notifications to regulators within 72h (GDPR Article 33).
3. **billing/finops** wants to deliver invoice receipts, dunning notices, budget breach alerts.
4. **marketplace** wants to notify tenants when a pack version is yanked due to a CVE.
5. **ml-training** wants to surface eval-set failures to the on-call ML lead.
6. **forensics** wants to alert legal counsel on legal-hold activation.
7. **Regulators and customers** drive hard requirements: CAN-SPAM (transactional vs marketing classification), CASL (explicit opt-in for marketing in Canada), GDPR (right to unsubscribe + suppression), HIPAA (PHI redaction in notification bodies), TCPA (SMS opt-in with double-confirmation, US).

The threat model is also concrete: spammy retries that bypass quiet hours, leaked content via the in-app inbox of a shared device, hard bounces that aren't honored (spam-list listing), security alerts that aren't deliverable because a user marked the address as "marketing spam", and password-reset emails that get rate-limited because they share a quota with newsletters.

This ADR establishes the contract types for outbound notification delivery. It does **not** include the actual SMTP / Twilio / FCM / APNs clients, the template-rendering engine, the queue worker, or webhook signing primitives — those are Phase 2 build artifacts consuming these contract types.

## Decision

Notifications contract has **six modules** in `@crossengin/notifications`:

1. **`channels.ts`.** Six channels (email, sms, push_mobile, in_app, webhook, voice_call) × 18 provider kinds (5 email: smtp_relay/sendgrid/mailgun/ses/postmark; 5 sms: twilio/vonage/aws_sns/messagebird/aws_pinpoint; 4 push: fcm/apns/expo/web_push; in_app_native; webhook_http; 2 voice: twilio_voice/vonage_voice). `CHANNEL_CAPABILITIES` declares per-channel limits — maxBodyBytes, HTML support, attachments, deep links, rich media, requiresOptIn, singleSegmentBytes (160 for SMS). `PROVIDERS_BY_CHANNEL` enforces channel↔provider compatibility. `ProviderConfigSchema` (zod superRefine) enforces: provider must support its channel; email requires fromAddress; webhook requires endpointUrl + webhookSecretSha256 (HMAC-SHA256); commercial providers require apiKeySha256. Helpers: `isWithinChannelLimits`, `isSingleSmsSegment`, `computeSmsSegments` (single-segment 160 chars, multi-part 153 chars per segment with concat header).

2. **`templates.ts`.** Five content categories (transactional, security_alert, system_notice, operational_digest, marketing) with two ReadonlySets — `NON_SUPPRESSIBLE_CATEGORIES` (transactional + security_alert cannot be opted out by user) and `REQUIRES_EXPLICIT_OPT_IN` (marketing must be opt-in per GDPR/CASL). Five-state template lifecycle (draft → in_review → approved → deprecated → retired) with `TEMPLATE_TRANSITIONS` map and `canTransitionTemplate`. Six variable types (string, number, boolean, date, url, currency). `TemplateContentSchema` discriminated union by channel — email (subject + htmlBody + plaintextBody required, no HTML-only), sms (single body ≤ 1600), push_mobile (title + body + optional deepLink + badge), in_app (title + htmlBody + severity), webhook (eventName + payloadJsonTemplate + hmac-sha256 signature), voice_call (SSML body + fallbackTextBody + voice). `NotificationTemplateSchema` enforces: content.channel === template.channel; bodySizeBytes ≤ channel limit; approved status requires approvedAt + approvedBy + four-eyes (approvedBy ≠ createdBy); deprecated requires deprecatedAt; no duplicate variable names. `validateRenderInput` returns `{ ok, missing, extra, typeMismatches }` so the renderer can fail fast before calling the provider.

3. **`audiences.ts`.** Six audience kinds (specific_user, specific_address, role_in_tenant, tenant_all_users, oncall_rotation, custom_predicate) as a discriminated union. Five on-call rotation kinds (primary, secondary, escalation_chain, follow_the_sun, weekend_only). `OncallShiftSchema` enforces endsAt > startsAt + backupUserId ≠ userId. `OncallRotationSchema` enforces escalation_chain rotation has non-empty chain. Helpers: `findActiveOncallUser(rotation, now)`, `resolveEscalationChain(rotation, attemptIndex)` — both deterministic, no I/O. `AddressBook` interface + `resolveUserAddress(userId, channel, book)` returns the channel-specific destination (single string for email/sms/voice/in_app, array of device tokens for push, null for webhook). `isAddressable` lets dispatch logic skip recipients with no matching address.

4. **`preferences.ts`.** Seven suppression reasons (hard_bounce, soft_bounce_exceeded, spam_complaint, manual_block, unsubscribe, do_not_contact_register, regulatory_block) — four of these in `PERMANENT_SUPPRESSION_REASONS` (hard_bounce, spam_complaint, do_not_contact_register, regulatory_block) and cannot have expiresAt set. `UserPreferenceMatrix` enforces no duplicate (category, channel) entries and blocks users from opting out of `NON_SUPPRESSIBLE_CATEGORIES`. `SuppressionRecordSchema` enforces: permanent reasons cannot have expiresAt; manual_block requires appliedBy; expiresAt > appliedAt. Helpers: `isSuppressionActive(suppression, now)`, `findActiveSuppression(suppressions, channel, address, now)`. The integration point is `computeDispatchEligibility({ category, channel, preferences, suppressions, recipientAddress, now }) → { eligible, reason, suppressionId }` — a single function that the dispatcher calls per recipient to decide whether to send. It correctly handles the case where a transactional category bypasses suppression (e.g., password reset to a hard-bounced address still tries; security_alert to an unsubscribed address still tries).

5. **`delivery.ts`.** Seven dispatch statuses (queued → rendering → rendered → sending → completed / failed / cancelled) with state machine. Ten delivery outcomes (queued, delivered, deferred, bounced_hard, bounced_soft, complained, dropped, failed, suppressed, rate_limited) partitioned into `TERMINAL_DELIVERY_OUTCOMES` (delivered, bounced_hard, complained, dropped, suppressed) and `RETRYABLE_DELIVERY_OUTCOMES` (deferred, bounced_soft, failed, rate_limited). Five priority levels with `PRIORITY_MAX_LATENCY_SECONDS` SLO (critical=60s, high=300s, normal=1800s, low=14400s, background=86400s). `NotificationDispatchSchema` enforces: completed needs completedAt; cancelled needs cancelledReason; delivered + failed + suppressed ≤ recipientCount; completedAt ≥ startedAt. `DeliveryAttemptSchema` enforces: initial attempt has attemptNumber=1; retry needs attemptNumber ≥ 2; retryable outcome requires nextRetryAt; terminal outcome forbids nextRetryAt; bounce/failed require errorCode; delivered SMS requires smsSegments; latencyMs = finalizedAt − sentAt within 1ms. `decideRetry` implements exponential backoff capped at 1 hour, respecting maxAttempts. `summarizeDispatches` returns `{ totalDispatches, totalRecipients, totalDelivered, deliveryRate, p50/p99 latency }` for observability dashboards.

6. **`throttling.ts`.** Six digest frequencies (immediate, every_15_minutes, hourly, daily, weekly, never), four quiet-hours behaviors (deliver_anyway, defer_to_morning, batch_until_morning, drop_silently). `QuietHoursConfigSchema` enforces start ≠ end (overnight ranges like 22:00 → 07:00 supported via wrap-around), and blocks marketing from bypassCategories — only transactional / security_alert / system_notice / operational_digest can bypass. `decideQuietHoursAction({ config, category, priority, localMinutesSinceMidnight })` returns `{ action: send_now | defer | batch | drop, reason }` with explicit handling for critical priority (always bypasses) and category bypass list. `RateLimitPolicy` covers per-recipient-per-hour, per-recipient-per-day (must be ≥ hourly), per-tenant-per-second, burst allowance, applicable categories, and `overrideForPriorities` (defaults to critical). `evaluateRateLimit({ policy, priority, hourlyCount, dailyCount, tenantPerSecondCount })` returns `{ allowed, reason }`. `countRecentDeliveries(attempts, recipientAddressSha256, channel, windowStart, now)` is a pure helper for the dispatcher to feed rate-limit evaluation. `DigestBatchSchema` represents an open batch awaiting assembly (digest frequencies exclude immediate + never since those don't batch); enforces itemCount ≤ maxItems, scheduledDispatchAt > openedAt, dispatched status requires dispatchedAt.

Six meta-schema tables: `META_NOTIFICATION_TEMPLATES` (platform-wide with nullable tenant_id + custom RLS, unique on (tenant_id, template_id, channel, locale, version)), `META_NOTIFICATION_PREFERENCES` (per-user × category × channel matrix, RLS-tenant-scoped), `META_NOTIFICATION_SUPPRESSIONS` (per-(tenant, channel, address) suppression entries), `META_NOTIFICATION_DISPATCHES` (one row per `notify X about Y`, unique on (tenant_id, idempotency_key) for safe retries), `META_NOTIFICATION_DELIVERIES` (per-attempt audit, CASCADE FK to dispatches), `META_NOTIFICATION_DIGESTS` (open digest batches per user × channel × frequency). All five FK back to META_TENANTS or META_USERS so deletes are blocked while history exists; templates support null tenant_id for platform-published templates.

## Alternatives considered

- **Option A:** Defer notifications until a later phase; let each package emit its own events.
  - **Pros:** Simpler contract surface today.
  - **Cons:** Every package currently has design language ("alert the admin", "page on-call") with no shared contract. Decisions about retry, suppression, quiet hours, and rate limits would be reimplemented six times with subtle drift.
  - **Why not:** Notifications crosscut every package shipped so far; consolidating now prevents downstream rework.

- **Option B:** Combine `templates.ts` and `content categories` into a single module.
  - **Pros:** Smaller file count.
  - **Cons:** Categories are referenced by preferences, suppressions, throttling, and templates. Putting them in templates.ts creates an import cycle (preferences would re-import templates only for the category enum).
  - **Why not:** Categories live in templates.ts but are re-exported broadly so other modules import freely.

- **Option C:** Make `Audience` a free-form expression / DSL.
  - **Pros:** Maximally flexible.
  - **Cons:** Every dispatcher needs an interpreter; ad-hoc DSL with no validation invites injection and tenant-isolation bugs.
  - **Why not:** Six concrete kinds cover 99% of use cases. `custom_predicate` is the escape hatch for the 1% — but it's typed as a string and explicitly tagged as needing review.

- **Option D:** Make user opt-out of transactional categories possible (full user choice).
  - **Pros:** Maximum user control.
  - **Cons:** Users opting out of password-reset emails or MFA codes create an unrecoverable account-loss path. The standard is "transactional is required for the relationship; only marketing requires opt-in." CAN-SPAM and CASL both encode this distinction.
  - **Why not:** `NON_SUPPRESSIBLE_CATEGORIES` enforces transactional + security_alert as user-non-suppressible. Admins can still apply a regulatory_block (e.g., court order) which is a separate path with audit trail.

- **Option E:** Per-channel rate-limit policies only.
  - **Pros:** Simpler model.
  - **Cons:** Real rate limiting needs three axes: per-recipient (don't flood one inbox), per-tenant (don't let one tenant burn provider quota), and per-category (marketing throttled tighter than transactional). The combined `RateLimitPolicy` covers all three.

- **Option F:** Skip digest batching at the contract layer; let consumers batch themselves.
  - **Pros:** Smaller surface.
  - **Cons:** Digest is one of the highest-leverage features (a tenant admin getting one daily summary instead of 50 individual emails). The state machine + dedup + max-items invariants belong with the rest of throttling.

## Consequences

- **Forces every notification through one contract.** Packages emit `NotificationDispatch` records; the dispatcher executes the eligibility → throttling → rendering → delivery pipeline. No per-package "let me just send an email" shortcuts.
- **Enforces opt-in/opt-out at the schema layer.** Marketing without explicit opt-in fails `computeDispatchEligibility`; transactional + security_alert correctly bypass suppression for non-spam reasons; permanent suppressions (hard bounce, spam complaint) cannot be re-enabled silently.
- **Anchors audit at the schema level.** Every dispatch + every delivery attempt is a typed record flowing into meta-schema audit tables. Compliance attestations and forensics can both consume.
- **Quiet hours respect timezones.** The contract takes `localMinutesSinceMidnight` (caller resolves user's timezone) — the contract itself is timezone-agnostic and deterministic, suitable for unit testing.
- **Webhook signing baked in.** Every webhook template has `signatureAlgorithm: "hmac-sha256"` (single literal). No path to ship unsigned webhooks.

## Open questions

- **Q1:** Should `RateLimitPolicy` support per-template overrides (e.g., MFA codes always allowed)?
  - _Current direction:_ Use `priority: "critical"` for those flows; rate-limit policy already exempts critical via `overrideForPriorities`. Template-level override would create a parallel mechanism; defer until we see concrete demand.
- **Q2:** Digest assembly — content combination across templates?
  - _Current direction:_ `DigestBatch` is metadata only at the contract layer (item_count, dedup_sha256). The actual "stitch N notifications into one email" is Phase 2 rendering work.
- **Q3:** Per-user notification "quiet windows" beyond global quiet hours (vacation auto-responder behavior)?
  - _Current direction:_ Treat as a user preference extension. Defer until a tenant requests it.
- **Q4:** SMS double-confirmation opt-in (TCPA US requirement)?
  - _Current direction:_ Modeled via `PreferenceMatrixEntry.source = "user_set"` — only user-set entries with explicit opt-in satisfy TCPA. The double-confirmation flow itself is a UI concern in `apps/`.
- **Q5:** Provider failover (try Twilio, fall back to Vonage)?
  - _Current direction:_ Out of scope for v1. `ProviderConfig` has rate limits + retry params; provider routing chains would extend later.

## References

- CAN-SPAM Act (US) — transactional vs commercial classification, opt-out timelines
- CASL (Canada Anti-Spam Legislation) — explicit consent for marketing
- GDPR Articles 12, 17, 21 — right to information, erasure, objection (suppression)
- TCPA (US Telephone Consumer Protection Act) — SMS opt-in
- HIPAA 45 CFR §164.514 — de-identification (no PHI in subject lines)
- RFC 3676 — Plain-text Email Format
- E.164 — international phone number format
- ADR-0008 (audit), ADR-0011 (integration mesh + HMAC), ADR-0017 (SLOs), ADR-0022 (i18n), ADR-0037 (incident response), ADR-0038 (SSO)
