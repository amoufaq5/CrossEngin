# ADR-0309: Read state, per-user quiet hours, and a dedup hash with a reader

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-02 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0273, ADR-0275, ADR-0276, ADR-0277, ADR-0278, ADR-0289, ADR-0302 |

## Context

Four of the notification stack's "contained" follow-ups were all the same kind of gap — a column or a
concept that existed and had nobody reading it:

- **No per-user read state** (ADR-0273, ADR-0278). "Unread" was a recency approximation: the inbox
  showed the newest N delivered notices and called them unread. That answers *what is new*, not *what
  have you seen*, and the two diverge the instant somebody reads one and reloads.
- **Quiet hours was tenant-only** (ADR-0275). One window, one timezone, for every recipient. A tenant
  with staff in two countries could silence nobody's night correctly.
- **`dedup_sha256` was declared and unused** (ADR-0276). The column existed; nothing computed it, so
  the same notice assembled twice by two replicas was two dispatches.
- **`notification_suppressions.applied_by` was a `meta.users` UUID** (ADR-0302) — the fifth instance of
  ADR-0289's finding, a column narrower than its contract. Every bounce-written row stored NULL, so
  "SES told us" was unrepresentable and the only suppressions the platform actually produces were the
  unattributable ones.

## Decision

**Read state is recorded two ways, because the two questions have different shapes.** A
`NotificationReadState` row per notice actually opened, and one `NotificationReadWatermark` per viewer
meaning "everything up to here is read". The watermark is not an optimisation of the rows — it is the
only form that can answer for notices the reader was never shown. A deployment enabling this sets a
watermark at go-live and the whole backlog reads as read, which is the truth: nobody opens three months
of receipts. As rows, that backfill is unbounded and has to be repeated for every pre-existing notice.

Three tables: `meta.notification_read_states`, `meta.notification_read_watermarks`,
`meta.notification_user_quiet_hours`.

**Quiet hours resolves per field, and the timezone is the user's while the window may be the tenant's.**
`resolveEffectiveQuietHours` takes the tenant policy, the user preference and an override `scope`
(`none` / `timezone` / `full`) and reports both the resolved values *and* where each came from.

The rule that needed deciding: a tenant window of 22:00–07:00 silences a user in `Asia/Tokyo` during
**Tokyo's** 22:00–07:00 — a different absolute interval, by nine hours. That is deliberate. A window is
a statement about the recipient's night; translating the tenant's clock would silence a Tokyo user
through their afternoon and mail them at 2am. A tenant that genuinely needs one absolute interval for
everyone sets `scope: "none"`, which ignores the user record entirely.

It **fails open to no quiet hours**, as ADR-0275 decided for the tenant document. An unreadable window
— no zone, an unknown zone, a degenerate span where start equals end — resolves to no policy, never to
a blanket hold. Quiet hours only ever *delays*, so the failure worth avoiding is the one where nothing
is ever sent.

**`dedup_sha256` is computed over a canonical payload.** `dispatchDedupHash` hashes sorted-key JSON of
`(tenantId, templateId, locale, channel, category, audience, …)` through an **injected** hasher, because
a contracts package may not reach for `node:crypto`. The canonicalisation is byte-identical in behaviour
to `canonicalAuditEntryPayload` (ADR-0286) and copied rather than imported, for the same reason it
exists there: the hash computed before an insert must match one recomputed from the `JSONB` audience
read back, and `JSONB` does not preserve key order.

**`applied_by` becomes TEXT holding a structured actor ref** — `user:<uuid>` / `system:<slug>` /
`provider:<slug>` — with the shape enforced by `SUPPRESSION_ACTOR_PATTERN` in the contract and a CHECK
in the column. It is **not** free text, unlike ADR-0289's `declaredBy`, and that difference is the
point: a rule branches on it. `manual_block` must name the human who placed it, and free text would let
`system:ses` satisfy that. The bounce webhook now writes `provider:ses` / `provider:twilio`, so the row
says who reported it.

It stays **nullable**, which is the one place we did not tighten. An existing deployment's bounce rows
were written NULL, and requiring an actor would make a replayer refuse rows that were legitimately
written under the old contract.

## Alternatives considered

- **Option A (read state):** rows only, no watermark.
  - **Pros:** one table, one concept; every read is individually attributable.
  - **Cons:** mark-all-read is an unbounded write, and the go-live backfill is impossible — you cannot
    write a row for a notice nobody will ever be shown.
  - **Why not:** the backfill case is not an edge case, it is day one.

- **Option B (read state):** watermark only, no per-notice rows.
  - **Pros:** O(1) per viewer; trivially correct for "what is new".
  - **Cons:** cannot represent reading the third notice and not the second, which is what people
    actually do with an inbox.
  - **Why not:** it reintroduces the recency approximation under a new name.

- **Option C (quiet hours):** translate the tenant window into the user's zone, preserving the absolute
  interval.
  - **Pros:** one interval platform-wide; simple to reason about for the tenant admin.
  - **Cons:** silences a Tokyo user through their working afternoon and mails them at 2am — the exact
    harm quiet hours exists to prevent.
  - **Why not:** it makes the feature actively wrong for the only tenants who need it. Available
    deliberately as `scope: "none"` for a tenant whose window is about *their* business hours.

- **Option D (quiet hours):** fail closed — hold when the window cannot be read.
  - **Pros:** consistent with CLAUDE.md's fail-closed invariant.
  - **Cons:** that invariant is about *access*, and this is about delivery. An unparseable timezone
    would silently stop a tenant's notifications indefinitely, including the security alerts that are
    non-suppressible precisely so they get through.
  - **Why not:** holding forever is the worse failure. Stated explicitly in the module so the
    divergence from the house rule is deliberate and visible.

- **Option E (`applied_by`):** free text, matching ADR-0289's `declaredBy`.
  - **Pros:** one precedent, no pattern to maintain, accepts anything a future caller invents.
  - **Cons:** `manual_block requires a human actor` becomes unenforceable — `system:ses` is a valid
    string. The rule would survive as a comment.
  - **Why not:** a field something branches on has to be parseable. The structure is what keeps the
    four-eyes-adjacent rule honest.

- **Option F (`applied_by`):** require an actor on every row, NOT NULL.
  - **Pros:** no unattributable suppressions ever again.
  - **Cons:** every row written before this ADR is NULL, so the re-parse-on-read replayer would refuse
    rows that were correct when written.
  - **Why not:** declined on the recommendation of the lane that found it. Breaking a replayer to
    tighten a column is the tail wagging the dog.

## Consequences

- **Positive:** "unread" means unread. A user in another country gets their own night. The same notice
  assembled on two replicas is one dispatch. A bounce-driven suppression names the provider that caused
  it, which is the difference between an audit trail and a list of mysteries.
- **Negative:** three more tables and a second read path for the inbox. Quiet hours now has a
  resolution order a support engineer has to know (hence `*Source` on every field of
  `EffectiveQuietHours` — the resolution is self-describing rather than requiring the reader to
  re-derive it). `applied_by` remains nullable, so "who" is still unanswerable for historical rows.
- **Neutral:** the dedup hash is injected rather than computed in-package, so a caller can get it wrong
  by passing a different hash. The schema validates the shape (64 lowercase hex) but cannot validate
  that it is a SHA-256 of the right bytes.
- **Reversibility:** the read-state tables are additive and unread by anything that does not ask for
  them; dropping the feature means ignoring them. The `applied_by` widening is not reversible without
  deciding what to do with every `system:`/`provider:` row — which is a data decision, exactly the kind
  ADR-0291 refuses to make automatically.

## Implementation notes

- `packages/notifications/src/read-state.ts`, `quiet-hours.ts`, `dedup.ts`; the actor vocabulary lives
  in `preferences.ts` beside the rule that branches on it.
- `localMinutesInTimeZone` uses `Intl.DateTimeFormat` with the zone, not a fixed offset table, so DST is
  the platform's problem and not ours. `isValidTimeZone` probes by construction and catches.
- `META_NOTIFICATION_READ_STATES`, `META_NOTIFICATION_READ_WATERMARKS` and
  `META_NOTIFICATION_USER_QUIET_HOURS` take the kernel catalog to 143 tables. `applied_by` moves from
  `UUID` + `USER_FK` to `TEXT` with a CHECK matching the actor pattern — and the `::uuid` cast in
  `apps/operate-server/src/suppression-store.ts`'s `INSERT … SELECT` had to go with it, or every
  non-`user:` actor would be rejected at the bind.
- Verified live: the three tables bootstrap and reconcile to no drift; a `provider:ses` row inserts
  where it previously violated the column type.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `applied_by` is still nullable, so historical bounce rows cannot say who. Backfill from `source_delivery_id`, or leave them? | amoufaq5 | _unscheduled_ |
| Nothing writes a read state over HTTP yet — the contract and the tables exist, the route does not. | amoufaq5 | _unscheduled_ |
| `dispatchDedupHash` has a reader in the planner but nothing enforces at the database that a dispatch carries one. | amoufaq5 | _unscheduled_ |

## References

- ADR-0273, ADR-0278 (the recency approximation), ADR-0275 (tenant quiet hours, fail-open),
  ADR-0276 (`dedup_sha256` unused), ADR-0286 (`canonicalAuditEntryPayload`), ADR-0289 (a column
  narrower than its contract), ADR-0302 (bounces, and the suppression that could not name a provider).
- ECMA-402 `Intl.DateTimeFormat` with an IANA `timeZone`.
