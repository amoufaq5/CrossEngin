# ADR-0302: Bounces feed suppressions, and three reasons they did not (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0274 (notification delivery), ADR-0301 (real channel senders), ADR-0292 (index definitions), ADR-0289 (re-parse on read) |

## Context

ADR-0274 left this open in one line: "No provider webhooks feeding bounces into suppressions — the
suppression table exists for exactly this and nothing populates it." With real senders in place
(ADR-0301) the loop had to close, because a hard-bounced address that keeps receiving mail is not a
cosmetic gap: bounce and complaint rates are what a provider throttles or pauses a whole sending domain
over, so one tenant's dead admin mailbox degrades every tenant's mail.

Writing the row turned out to be the easy half. Three defects, each found by measurement rather than
review, meant a written suppression would not have suppressed anything.

**1. A non-suppressible category overrode every suppression reason.** `computeDispatchEligibility`
asked only `isCategorySuppressible(category)`, and `transactional` / `security_alert` are
non-suppressible — so a hard-bounced address kept receiving transactional mail, which is the bulk of
ERP mail. The rule conflated *consent* with *deliverability*: nobody may unsubscribe from a receipt,
but a receipt cannot arrive at a mailbox that does not exist.

**2. The unique constraint named `_active` had no predicate.** `UniqueConstraint` is `{name, columns}`
with no `where`, so `notification_suppressions_tenant_channel_address_active` was a *total*
`UNIQUE (tenant_id, channel, recipient_address)` — nothing in the schema defined "active", only the
reader's `expires_at` filter did. Measured: a lapsed suppression occupied its address forever, so an
address that once soft-bounced could **never afterwards be hard-bounce-suppressed**.

**3. Fixing (2) exposed a reconciler defect.** `IndexDelta.constraintBacked` was set from the
*declaration*, so an index the catalog declares plainly but the database holds under a constraint read
as not constraint-backed, and the plan emitted `DROP INDEX` — which Postgres refuses: *cannot drop
index … because constraint … requires it*. The plan held a step that could not succeed, breaking its one
invariant (ADR-0290).

## Decision

**Suppression reasons split by what they mean.** `UNCONDITIONAL_SUPPRESSION_REASONS` —
`hard_bounce`, `soft_bounce_exceeded`, `spam_complaint`, `do_not_contact_register`,
`regulatory_block` — refuse the send whatever the category. `manual_block` and `unsubscribe` remain
overridable, which is what keeps an address from blocking its own security alerts.
`findActiveSuppression` prefers an unconditional reason over an overridable one so the outcome does not
depend on row order: an address carrying both an unsubscribe and a hard bounce is undeliverable
whichever the reader lists first.

**The address uniqueness becomes a predicated unique *index*,** `WHERE expires_at IS NULL`, because
only an index takes a predicate. The predicate cannot mention `now()` — Postgres requires an IMMUTABLE
index predicate — so "permanent" stands in for "active": a permanent suppression is unique per address,
temporary ones may accumulate, which the reader already tolerates. The store's `NOT EXISTS` guard
mirrors that predicate exactly; without the `expires_at IS NULL` filter it would have re-imposed the
same defect one layer up.

**`constraintBacked` is read from the live index.** `LiveIndex` gains the field from
`pg_constraint.conindid`, and the planner, on finding a declared index the database holds under a
constraint, emits `ALTER TABLE … DROP CONSTRAINT` followed by `CREATE UNIQUE INDEX` in one statement.

**The webhook verifies the platform's own HMAC, not the provider's.** `POST
/v1/notifications/bounces/{tenantId}/{ses|twilio}` expects a body the platform's edge has re-signed
with `signWebhookPayload`: providers sign with their own schemes, and the one place the raw bytes exist
is in front of the gateway, because a gateway `Handler` only ever sees a *parsed* body and
`JSON.stringify(parse(body))` is not byte-identical — a Twilio status callback is form-encoded and
would not survive a JSON round-trip at all. So the route wraps the dispatch target rather than
registering as a gateway route, which also keeps it available to the Fetch/Workers adapter.

The secret is one platform value, `NOTIFICATION_BOUNCE_SECRET`, **derived per tenant** as
`HMAC-SHA256(secret, "bounce-webhook:" || tenantId)`. The signer is the platform's edge, not the
tenant, so a per-tenant *stored* secret would be ceremony; but deriving costs one hash and buys a real
property, that a signature captured for one tenant cannot be replayed against another. A secret under
32 characters refuses to serve the route at all, rather than warning: anyone who guesses it can silence
a tenant's mail, so the route not existing is the safer failure.

A write is **idempotent and never an update**. `ON CONFLICT … DO UPDATE` would move `applied_at` and
could extend an expiry on every replay, which hands anyone holding one captured signed body a way to
keep an address suppressed indefinitely.

## Alternatives considered

- **Option A: verify each provider's own signature (SNS message signature, `X-Twilio-Signature`).**
  - **Pros:** no edge component; the platform trusts the provider directly.
  - **Cons:** two schemes to implement and keep current, SNS requires fetching and caching AWS signing
    certificates, and neither payload names a CrossEngin tenant — so the tenant has to come from the
    path regardless.
  - **Why not:** one envelope the platform controls is smaller and testable offline. The edge that
    terminates the provider is a deployment component either way.

- **Option B: treat `hard_bounce` as overridable for `security_alert` only.**
  - **Pros:** a security alert is the one message you most want delivered.
  - **Cons:** it cannot be delivered — the mailbox does not exist — and the attempt feeds the bounce
    rate that throttles the domain. Wanting it delivered does not make the address reachable.
  - **Why not:** the honest answer is to suppress and surface the undeliverable address, not to keep
    mailing it.

- **Option C: drop `reason` from the suppression id hash so the id and the unique tuple agree.**
  - **Pros:** `ON CONFLICT (suppression_id) DO NOTHING` alone would suffice; no migration.
  - **Cons:** silently changes every id, and the id would then not commit to the reason it records.
  - **Why not:** the two guards are cheap and the id staying honest is worth more.

- **Option D: a `where` on `UniqueConstraint` instead of moving to `indexes`.**
  - **Pros:** keeps the declaration where it was.
  - **Cons:** Postgres has no predicated unique *constraint*; it would emit a unique index anyway, so
    the vocabulary would misdescribe what it produces.
  - **Why not:** `IndexSpec` already has `where`. The honest declaration is an index.

## Consequences

- **Positive:** the loop closes. Measured on a live cluster, the same two-recipient dispatch went from
  2 delivered / 0 suppressed, to 1 / 1 after the category fix, to **0 delivered / 2 suppressed with no
  provider calls at all** once the webhook had recorded a real signed SES bounce for the second
  address.
- **Negative:** a verified-but-not-suppressible event answers 422, so a provider retries it forever.
  The refusal is deterministic and writes nothing, so it is noisy rather than harmful.
- **Negative:** `applied_by` is a nullable UUID foreign key to `meta.users`, so a provider-driven
  suppression can only write NULL — "SES told us" is unrepresentable except through `notes`.
  `source_delivery_id` carries the real provenance, so this is a legibility gap, not a lost fact.
- **Neutral:** an unknown tenant and a bad signature are deliberately indistinguishable (both 401),
  because distinguishing them makes the route a tenant-existence oracle for anyone who can POST to it.
  The real reason goes to `onRefusal`, server-side.
- **Neutral:** address matching is exact and case-sensitive. A bounce reporting `Bounced@Example.test`
  against a stored `bounced@example.test` writes a suppression that never matches. Normalising in the
  store would make the id — which commits to the exact address — a lie; it belongs upstream in
  `planSuppression` if it is wanted.
- **Reversibility:** omitting `--bounce-webhook` stops serving the route. The predicated index and the
  eligibility split are not reversible without reintroducing the three defects.

## Implementation notes

- `packages/notification-providers/src/bounce-webhook.ts` — SES (`eventType` / `notificationType`) and
  Twilio parsing into a planned `SuppressionRecord[]`; writes nothing itself.
- `packages/notifications/src/preferences.ts` — `UNCONDITIONAL_SUPPRESSION_REASONS`,
  `isSuppressionUnconditional`, and the ordering preference in `findActiveSuppression`.
- `apps/operate-server/src/suppression-store.ts`, `bounce-webhook-routes.ts`, `bounce-webhook-env.ts`.
- `packages/kernel-pg/src/introspection.ts`, `diff.ts`, `reconcile.ts` — `constraintBacked` from the
  live index.
- **Migration:** an existing database takes one statement, `DROP CONSTRAINT` + `CREATE UNIQUE INDEX`
  together. Measured in both directions: it failed before the reconciler fix with exactly the error
  above, and succeeded after, converging to a clean no-op plan.
- Live verification: a valid signed bounce records one row (200); a replay records none and reports
  `already_present` with `applied_at` unmoved; a tampered signature and a signature made with another
  tenant's derived key are both 401 with nothing written; a malformed tenant in the path is 404. A
  lapsed temporary suppression no longer blocks a later permanent one — the case that was impossible —
  while a second *permanent* reason for one address is still refused.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `applied_by` cannot name a provider. Widen it to TEXT with a system sentinel, as ADR-0289 did for incident actors? | amoufaq5 | _unscheduled_ |
| Address normalisation in `planSuppression`, so a differently-cased bounce still matches. | amoufaq5 | _unscheduled_ |
| 422 on a non-suppressible event means unbounded provider retries. Flip to 200? It is one line in `statusForRefusal`. | amoufaq5 | _unscheduled_ |
| `PostgresRecipientResolver.activeSuppressions` **skips** an unparseable row, which fails open — the next drain mails the address the row existed to protect. The store refuses instead. Reconciling the two is a deliberate behaviour change: refusing makes one bad row an outage of that tenant's notifications. | amoufaq5 | _unscheduled_ |

## References

- AWS SES event publishing: `Bounce`, `Complaint`, `Delivery`; bounce and complaint rate thresholds.
- Twilio status callbacks and error codes.
- ADR-0274, ADR-0289, ADR-0290, ADR-0292, ADR-0301.
