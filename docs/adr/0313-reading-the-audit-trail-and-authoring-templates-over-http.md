# ADR-0313: Reading the audit trail, and authoring templates, over HTTP

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-02 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0277, ADR-0279, ADR-0286, ADR-0289, ADR-0303, ADR-0298 |

## Context

ADR-0277 and ADR-0279 recorded the same gap twice: "No route authors a template or reads the audit
trail over HTTP."

Both tables had carried a full lifecycle since Phase 1 and neither had a reader.
`meta.notification_templates` meant a tenant wanting its own invoice email was handed direct SQL.
`meta.audit_log` — hash-chained, anchored, the thing the whole forensics stack exists to make
trustworthy — could only be read by somebody with a database connection, which is the one population an
audit trail is least able to hold to account.

## Decision

### Reading the trail: `GET /v1/audit/entries` and `/v1/audit/entries/{id}`

Four properties, each one a leak somewhere if it is not held:

**A read of the trail is itself privileged, so it is recorded before it is served.** `recordRead` is not
optional — there is no way to construct the routes without it — and a granted read whose record cannot
be written is refused with 503 rather than served unaudited. "We served it but cannot say who asked" is
precisely the state an audit trail exists to prevent. The record goes into `meta.audit_log` itself, so
reading the trail appears in the trail. A *denial* is recorded too, best-effort: somebody probing for
another tenant's trail is worth knowing about, but a failure to record a denial does not become a 503,
because turning a 403 into a 503 tells a prober the recorder is down.

**The grant decides the scope, not the path.** One listing serves a tenant reading its own entries and a
platform operator reading across tenants. A tenant grant naming *another* tenant is a 403, **not** a
silently-narrowed query: a reader who believes they searched every tenant and found nothing has been
misled about the one fact the trail exists to establish.

**Payload redaction is classification-driven and withholds rather than guesses.** A sensitive field
(pii/phi/regulated/commercial_sensitive) is redacted unless the reader is privileged; an entity the
classification source does not know has its payloads withheld **whole** rather than served
unclassified; and a payload key the entity does not declare is dropped, because a value nothing
describes is a value nobody decided may be read. `AUDIT_ACTOR_CLASSIFIED_FIELDS` runs the actor's own
`ip` and `userAgent` through the same redaction rather than special-casing them — an audit trail is read
by people entitled to know *what* happened without being entitled to know from which device.

**Keyset pagination, not offset.** The log is append-only and busy; an offset page shifts under a reader
as rows arrive, which in an audit trail means a record that was never shown to anybody who paged past
it.

### The policy that made the cross-tenant scope possible

`meta.audit_log` needed a second RLS policy, and the failure without it is not an empty result. Measured
against a real cluster as a non-owner role, a platform-elevated read against a plain tenant-isolation
policy raises `invalid input syntax for type uuid: ""`.

`current_setting('app.current_tenant_id', true)` returns NULL only until that setting has been *used
once* on the connection; afterwards its reset value is the empty string, and `''::UUID` throws. So the
failure appears on every pooled connection that has previously served a tenant — in production, and not
in a fresh `psql` session.

Two policies, both verified live as a non-owner role:

| Policy | Command | `USING` |
|---|---|---|
| `audit_log_tenant_isolation` | `ALL` | `tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID` |
| `audit_log_platform_audit_read` | `SELECT` | `current_setting('app.platform_audit', true) = 'on'` |

**Both halves matter, separately.** The `NULLIF` guard is what stops the cast from throwing — adding the
SELECT policy alone does not help, because the other policy's cast still evaluates. And splitting the
read off as `SELECT` is what stops the elevation from also satisfying an **INSERT's** `WITH CHECK`,
which would turn a read grant into the ability to forge an entry into another tenant's chain. ADR-0298's
`command` field exists for exactly this; this is its first user, and the first catalog policy to leave
the `ALL` default.

The flag is `app.platform_audit`, shared with `meta.audit_integrity_verdicts` (ADR-0303): reading the
chain and reading the verdict about it are one privilege.

### Authoring templates: `/v1/notification-templates`

Draft, read, list, and walk `TEMPLATE_TRANSITIONS`. There is deliberately **no** route that writes an
approved template in one step, because the approval is the only part of this that matters.

**Four-eyes, at three layers.** An author may not approve their own template. The contract refuses a
stored row where `approvedBy === createdBy`; the route refuses the request; and the store's `UPDATE`
carries `created_by <> $actor` as a **predicate**, so a race cannot land one either. Three layers for
one rule, because the only way a privileged action stays privileged is if the check holds at the layer
that actually writes.

**Authored content is executable, so it is refused rather than stored.** A template body is rendered
into an email and into the in-app inbox, where `in_app.htmlBody` reaches a browser as markup. The
renderer escapes *substituted values*; the body itself is author-supplied HTML. A `<script>` tag, an
`onerror=` attribute or a `javascript:` action URL in the body is stored XSS against every recipient in
the tenant — and `z.string().url()` accepts `javascript:alert(1)` quite happily, so the contract does not
stop it.

`validateTemplateContent` classifies each authored field by **how it reaches a recipient** (`plain` /
`markup` / `ssml` / `json` / `url` / `identity`) and checks it accordingly, yielding typed
`ContentRefusal`s. A payload in the database is a payload some other reader will eventually render, so
nothing unsafe is stored on the assumption that a reader will sanitise.

**A third grant for non-suppressible categories.** `security_alert` and `transactional` override a
recipient's preferences *and* their suppressions by design (ADR-0302's
`UNCONDITIONAL_SUPPRESSION_REASONS` notwithstanding), which is how a marketing blast reaches somebody
who unsubscribed. Authoring one is therefore its own grant, fail-closed, defaulting to **nobody**.

## Alternatives considered

- **Option A (audit read):** make `recordRead` optional and log to stdout when absent.
  - **Pros:** the routes work without a chain-backed emitter; a small deployment gets the read surface.
  - **Cons:** a privileged cross-tenant read whose only trace is a log line that rotates is an
    unaudited read with extra steps.
  - **Why not:** the recorder is required, and `operate-server` refuses to mount the routes without
    `--audit-chain-config` rather than degrading. The surface stays closed instead of opening a
    privileged read that leaves no trace.

- **Option B (audit read):** one combined policy, `tenant_isolation OR platform_audit`.
  - **Pros:** one policy, one predicate, the obvious shape — and it is what
    `meta.audit_integrity_verdicts` already uses.
  - **Cons:** on an `ALL`-scope policy the `USING` expression also serves as the `WITH CHECK`, so the
    elevation would let a platform session **insert** a row into any tenant's chain. For a verdicts
    table that nothing else writes, the combined form is acceptable; for the audit log it is a forgery
    path.
  - **Why not:** measured and rejected. The INSERT refusal is verified live.

- **Option C (audit read):** narrow the scope silently when a tenant grant names another tenant.
  - **Pros:** no error path; the reader gets their own entries.
  - **Cons:** they believe they searched something they did not. In an audit context that is the single
    worst answer available.
  - **Why not:** 403.

- **Option D (templates):** store the content and sanitise at render time.
  - **Pros:** one sanitiser, applied consistently; the author's input is preserved verbatim for review.
  - **Cons:** there is more than one renderer (email, in-app, SSML for voice) and each would need its
    own correct sanitiser forever. A row in the database is reachable by a reader nobody has written
    yet.
  - **Why not:** refusing at the boundary means there is one place to be right.

- **Option E (templates):** let the approver role double as the non-suppressible-category grant.
  - **Pros:** one fewer flag; an approver is already trusted.
  - **Cons:** approving a template and deciding that a category may ignore a recipient's opt-out are
    different decisions with different legal weight (GDPR consent, CAN-SPAM).
  - **Why not:** separate, fail-closed, default nobody.

## Consequences

- **Positive:** the audit trail is readable by the people accountable for it, and every such read is
  itself in the trail. A tenant can author its own templates without a DBA, and cannot author stored
  XSS or approve its own draft. ADR-0298's `command` field has a user, and the tenant-GUC cast defect is
  closed on the table where it mattered most.
- **Negative:** the audit-read surface needs `--audit-chain-config`, so a deployment without the chain
  cannot read its trail over HTTP at all. Template content refusal will reject some legitimately
  intended markup — an author who wants an `onclick` handler cannot have one.
- **Neutral:** `meta.audit_log.tenant_id` is `NOT NULL`, so a cross-tenant read is recorded against the
  *reader's* own tenant (`AuditReadEvent.readerTenantId`) rather than against no tenant. A reader with
  no resolvable tenant therefore cannot read — the same fail-closed direction the grant resolution
  already takes.
- **Reversibility:** both route sets are opt-in flags. The second RLS policy is additive and, once a
  deployment has it, removing it would be the loosening ADR-0291 refuses — so it is reported rather than
  dropped, which is the correct asymmetry for a policy.

## Implementation notes

- `audit-read-routes.ts` / `audit-read-store.ts`; `notification-template-routes.ts` /
  `notification-template-store.ts`.
- `entityFieldLookupFrom(manifest)` builds the classification source from the served manifest's declared
  fields. Trait-added columns are **not** among them, so a payload carrying `created_at` has that key
  dropped as undescribed; a deployment wanting them readable builds the lookup from the kernel's
  `resolvedFields` instead.
- `PostgresAuditReadStore.read` sets `app.platform_audit` transaction-locally for an `all` scope and adds
  no tenant predicate; a `tenant` scope goes through `withTenantContext` and binds `tenant_id = $1`
  anyway, so RLS and the query agree.
- Flags: `--audit-read-routes`, `--audit-read-tenant-role`, `--audit-read-platform-role`,
  `--audit-read-sensitive-role` (default **none** — everyone gets the redacted view),
  `--audit-read-max-range-days`; `--notification-template-routes`, `--notification-template-author-role`,
  `--notification-template-approver-role`, `--notification-template-unconditional-role`.
- Verified live on a throwaway cluster as a **non-owner** role: tenant read sees its own row only; the
  GUC's reset value after that transaction is `''`; the platform-elevated read on the *same* connection
  returns both tenants' rows rather than raising; and an INSERT under the elevation fails with `new row
  violates row-level security policy`.
- Verified live through the real server against two tenants' rows. In one response: the read's *own*
  prior entry (`audit.entries_read`, anchored at sequence 4 — reading the trail appears in the trail);
  the actor's `ip`/`userAgent` listed in `redactedFields` rather than silently dropped;
  `Product.unit_cost` redacted as `commercial_sensitive` while `name` survived;
  `payloadWithheld: "unclassified_entity"` on the `AuditLog` entity itself, which the manifest does not
  declare; and `anchored: false` on a hand-inserted row, reported as unproven rather than intact.
  Refusals measured: another tenant named → 403 `cannot read another tenant's audit trail`; an ungranted
  role → 403; no credential → 401. The template route refused `<script>` with 422
  `template_content_rejected` / `unsafe_markup`.
- **A gate found only by booting the server.** `--audit-read-routes` needs the `PostgresAuditEmitter`,
  which was constructed behind a list of feature flags this one was not in — so the surface warned and
  skipped, and a deployment that asked for it silently got nothing. This is the *second* instance of that
  mistake (ADR-0288 records the first, where `--integrity-proof-config` alone reported `audited=false`
  for every escalation). The condition is now the named predicate `needsAuditEmitter`, with a test that
  asserts each flag is individually sufficient — the previous form was inline, so nothing could assert
  over it. `--audit-read-routes` and `--notification-template-routes` also now fail at *parse* on
  `--store memory`, like every sibling flag, rather than warning at boot.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A platform read is recorded against the reader's own tenant. Should platform-initiated reads have their own audit scope instead of borrowing one? | amoufaq5 | _unscheduled_ |
| `--audit-read-sensitive-role` grants unredacted payloads wholesale; per-class grants (pii but not phi) are not expressible. | amoufaq5 | _unscheduled_ |
| Nothing reads the template *audit* trail over HTTP, which was the other half of ADR-0279's note. | amoufaq5 | _unscheduled_ |

## References

- ADR-0277, ADR-0279 (the two gaps), ADR-0286 (`canonicalAuditEntryPayload`, the anchored row),
  ADR-0289 (re-parse on read), ADR-0298 (`command` and `roles` on a policy), ADR-0303 (`app.platform_audit`
  and the verdict routes), ADR-0302 (non-suppressible categories).
- PostgreSQL: an `ALL`-scope policy's `USING` expression also serves as its `WITH CHECK`;
  `current_setting(…, true)`'s reset value after a transaction-local `set_config` is `''`, not NULL.
