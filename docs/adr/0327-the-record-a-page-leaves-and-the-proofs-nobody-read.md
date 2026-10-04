# ADR-0327: The record a page leaves, and the proofs nobody was reading

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-04 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0288, ADR-0289, ADR-0292, ADR-0293, ADR-0301, ADR-0304, ADR-0310, ADR-0313, ADR-0320, ADR-0321, ADR-0322, ADR-0323, ADR-0324, ADR-0325, ADR-0326 |

## Context

ADR-0326 closed every follow-up ADR-0324 and ADR-0325 had left open, and opened six of its own. This
increment closes those, plus four older open ends that turned out to share a shape: **something was
built, correct, and read by nothing.**

**A page left no mark on the incident it was about.** ADR-0326 made a delivery attempt evidence by
writing it to `meta.audit_log`. But `meta.audit_log.tenant_id` is NOT NULL, and an SLO surface is
never a tenant — so for one of the three escalators the row is *structurally impossible*, and the
record of being woken at 03:14 existed only in a log line. The `IncidentRecord`, which is the
artefact an incident review actually opens, said nothing about having paged anybody.

**A retrying page ignored the one thing the provider told it.** ADR-0326 reclassified HTTP 429 from
`rejected` to `failed` precisely so a rate-limited page is retried — and then retried it at a fixed
2s and 4s, inside the window the provider had asked us to wait out. `Retry-After` was sitting in the
response. A retry that re-presents itself before the provider will accept it is *less* likely to
succeed than one attempt would have been.

**The SLO resolve could not survive a restart.** ADR-0326's rule is that a resolve must reach exactly
where its trigger did, because `AlertPolicy` maps a severity to a channel set — so the grade is the
route. The SLO loop cannot read the grade off its own decision (a `recovered` decision carries none;
the breach is over), so it remembered what it delivered, in process. A restart mid-breach forgot, and
resolved nothing.

**Every tombstone the synchronous deletion route ever wrote was unverified.** Both audit directions
start from a *request*: `reconcileStranded` walks `in_progress` ones, `auditCompleted` walks
`completed` ones. A tombstone written by `--tenant-deletion-routes` has no request at all. And
`verifyStoredEvidence` is the **only** detector for a tampered `scope`, because — ADR-0323's finding —
`proofSha256` commits to `contentManifestSha256` and the chain entry commits to the two digests and
the identity, and **neither commits to the scope**. So for those proofs a rewritten scope left every
digest and the chain entry byte-identical and no code path looked. Live, on a throwaway database with
six tombstones, the new sweep found one: `tomb_live0003abcd`, unreferenced, `scope_tampered`.

**The question reconciliation asks on every tick was a sequential scan.** `findForRequest` — ADR-0322's
conclusive evidence that a deletion committed — reads `related_deletion_request_id`, which had no
index, on a table that only grows and is never pruned.

**Mobile push was built, tested, and unreachable.** ADR-0310 shipped `FcmPushSender` and made the
access token an injected seam, because minting one is a private key, a second endpoint and a refresh
cache — none of which belongs in a pure FCM client. `buildSenderRegistryFromEnv` then never
constructed it, because "env vars cannot express an `FcmAccessTokenProvider`". They can express the
*credential*.

**And the audit emitter's flag list had been wrong three times.** `needsAuditEmitter` enumerated every
flag whose feature writes an audit row. ADR-0288 was the first miss. `--audit-read-routes` was the
second, found by booting the real server. The third was found by this increment and had got through
the per-flag test added after the second: `--deletion-escalation-config` was listed **in the test**
and **absent from the predicate**, and the test passed anyway because the argument parser happens to
turn `--deletion-request-routes` on alongside it. A per-flag test over a hand-maintained list cannot
catch a flag missing from both copies of itself.

## Decision

1. **A page is appended to its incident's timeline.** `TimelineEntry.kind` gains `"paged"`, with
   `pagedTimelineMetadata` / `pagedTimelineMessage` as the one shape its three callers share, and
   `IncidentExecutor.notePage` / `PostgresIncidentStore.appendPagedNote` to write it. The note
   carries channel **kinds**, counts and the provider's own handle, and nothing from the finding —
   ADR-0310's rule, inherited because the note is read by the same people. It works where the audit
   row cannot: the timeline has no tenant column.

2. **The audit emitter is gated on nothing but a database.** The flag list is deleted.
   `auditEmitterAvailable(options)` is `options.store === "pg"`, which is the only condition that was
   ever real — constructing a `PostgresAuditEmitter` is an object allocation, so gating it never
   bought anything and cost three defects. A feature added tomorrow cannot omit itself from a list
   that no longer exists.

3. **A retry waits as long as the provider asked.** `parseRetryAfter` handles both RFC 9110 forms,
   the wait is `max(policy.delayMs, retryAfterMs)` — the policy's delay is the platform's floor, so
   `Retry-After: 0` cannot become a hot loop — and a request for longer than
   `MAX_RETRY_AFTER_MS` (30s) **stops** the retry rather than holding the page past the point where
   it is still a page. `retryAfterMs` reaches the audit row.

4. **A resolve for an episode this process did not page is recovered from the store.**
   `IncidentDeclarer.findById?` is the read; `defaultRecoverPages` plans from `record.severity`.
   Remembered beats recovered — the remembered directives are what actually went out — and all three
   ways of not knowing (no declarer, no `findById`, `null`) answer `[]`, which leaves the alert up
   for a human.

5. **A third audit direction starts from the proofs.** `PostgresTombstoneStore.scanAll` is a
   keyset-paged platform-wide sweep and `DeletionReconciler.auditTombstones` verifies each row,
   classifying a finding as `unreferenced`, `referenced` or `dangling` — the last being a proof
   naming a request that is **gone**, which is not the same fact as a proof naming none.
   `GET /v1/platform/tombstones/unproven` serves it, and `DeletionScheduler` sweeps **one page per
   audit tick**, lapping when it reaches the end.

6. **`meta.tenant_tombstones` indexes `related_deletion_request_id`, partially** — the column is NULL
   for every tombstone the synchronous route writes, and those rows can never match a lookup by
   request id, so indexing them would be bloat on a table that only grows.

7. **Mobile push is built from the environment.** `ServiceAccountFcmTokenProvider` mints and caches
   the token; `buildFcm` wires it from `FCM_PROJECT_ID` plus the service-account key. And a token
   mint that **cannot** succeed is now `dropped` rather than `failed`: letting `invalid_grant`
   propagate made a permanently-wrong service account indistinguishable from a 5xx blip, so the
   dispatch was retried forever. A credential FCM itself refuses is discarded from the cache, so it is
   not re-presented for the rest of its lifetime.

## Alternatives considered

- **Option A: keep `needsAuditEmitter` and add the missing flag.** The fix applied twice before.
  - **Pros:** smallest diff; the list documents which features audit.
  - **Cons:** it is the third miss, and the second one had a test designed to prevent exactly it. The
    list has two copies (predicate and test) and a flag can be missing from both.
  - **Why not:** the gate protects nothing. An emitter is `new PostgresAuditEmitter(conn, …)` — no
    connection, no scheduler, no DDL. Removing it also exposed four `auditEmitter === null` branches
    that could never fire, three of whose messages claimed `--audit-chain-config` was *required* when
    it was not; two surfaces now warn that their rows will be **unanchored** and mount anyway, which
    is ADR-0322's rule rather than a refusal that never fired.

- **Option B: record a platform-scope page against a sentinel tenant.**
  - **Pros:** one code path; every page gets an audit row.
  - **Cons:** files one tenant's record under another's RLS scope, which ADR-0325's recorder already
    refuses to do by design.
  - **Why not:** the incident timeline is the right home for a fact about an incident, and it has no
    tenant column to lie about.

- **Option C: make `Retry-After` replace the policy delay instead of raising it.**
  - **Pros:** obeys the provider exactly.
  - **Cons:** `Retry-After: 0` is legal and would turn the retry into a hot loop against a provider
    that is already struggling.
  - **Why not:** the policy's delay is a floor the platform owns; the provider's figure is a floor it
    owns. `max` respects both.

- **Option D: have the SLO loop re-plan its resolve from the policy at a default grade.**
  - **Pros:** no store read, no new seam.
  - **Cons:** it is ADR-0326's defect exactly — a resolve routed by a guessed grade closes an alert at
    a provider that never had one.
  - **Why not:** the stored record is the only non-guessing source, and when it cannot be read the
    honest answer is to resolve nothing.

- **Option E: have `auditTombstones` report only the *unreferenced* findings,** since a referenced one
  is reachable through `auditCompleted`.
  - **Pros:** no duplicate findings between the two directions.
  - **Cons:** wrong twice. `auditCompleted` walks only `status = 'completed'` requests under its own
    limit, so a tombstone whose request sits `in_progress` or `rejected` would fall through **both**;
    and it would make this sweep's coverage depend on another sweep's filter.
  - **Why not:** a duplicate finding dedupes on the tombstone id. A missed one does not come back.

- **Option F: sweep the whole tombstone table on each audit tick.**
  - **Pros:** a tamper is found on the next tick rather than within a lap.
  - **Cons:** the table only grows and is never pruned, so the tick's cost rises forever and
    eventually exceeds its own interval.
  - **Why not:** one page per tick walks it at a steady rate. Finding a tamper within a lap is the
    right trade against nothing finding it at all, which is the status quo.

- **Option G: make `findById` a required method on `IncidentDeclarer`.**
  - **Pros:** no optional-chaining; every declarer answers.
  - **Cons:** breaks every implementation and every test double in the repo at once, for no gain —
    the only caller has to handle "cannot tell" regardless.
  - **Why not:** `PageChannelSender.resolve?` set the precedent in ADR-0326, and absent/`null` are
    made to mean the same thing to a caller by contract.

- **Option H: import `FcmTokenError` into `push-fcm.ts` for an `instanceof`.**
  - **Pros:** precise.
  - **Cons:** the pure FCM client would depend on the token-minting module, undoing the separation
    ADR-0310 created the seam for, to learn one boolean.
  - **Why not:** checked structurally instead — the contract is "a provider may report
    retryability", and one that reports nothing is treated as retryable, which is the behaviour this
    had before.

## Consequences

- **Positive:** an incident record now tells the whole story — declared, paged, resolved — including
  for the platform-scope episodes that can leave no audit row at all. A rate-limited page waits the
  time it was told to. A breach that spans a restart still closes its alert. Every stored Article 17
  proof is verified on a schedule, including the ones no request names, which until now were
  verified by nothing. The reconciler's hot question has an index. Push works. And the audit emitter
  can no longer be forgotten, because there is nothing left to remember.
- **Negative:** the tombstone sweep's coverage is a *lap*, so a tamper is found within one pass of the
  table rather than at once. The FCM token's cache means a revoked key can still 401 once before the
  cache is discarded. `appendPagedNote` is the only writer that does not go through
  `PersistentIncidentEngine.apply`, so its appends are not covered by that path's `assertAppendOnly`
  check (the executor's append-only behaviour is pinned by a test instead).
- **Neutral:** two surfaces (`--tenant-erasure-routes`, `--audit-read-routes`) now warn at boot about
  unanchored rows where before they said nothing. Behaviour is unchanged; the silence was the bug.
- **Reversibility:** every piece is additive except the deleted flag list, and that one is a strict
  widening — an emitter exists in more cases than before, never fewer.

## Implementation notes

- `packages/incident-response/src/incidents.ts` — `"paged"`, `PagedTimelineFacts`,
  `pagedTimelineMetadata`, `pagedTimelineMessage`. The channel-kind pattern is the *mechanical* half
  of the no-leak rule: an address, a `+1555…` number, a `#channel` and a mixed-case routing key are
  all structurally rejected, and the refusal names the **position, not the value**, because a
  rejected "channel kind" is exactly the thing that might be an address and the message goes to a log.
- `packages/incident-response-runtime/src/executor.ts` — `notePage`, callable on **any** status
  including `closed` and `cancelled`, because a resolve's note arrives *after* the close-out and
  refusing on a terminal status would drop precisely the note that says the alert was closed.
- `packages/incident-response-runtime-pg/src/incident-store.ts` — `appendPagedNote`, which never
  throws and retries a lost revision race three times before reporting `revision_conflict`.
- `packages/incident-response-runtime/src/declarer.ts`, `fallback-declarer.ts`,
  `…-pg/src/declarer.ts` — `findById?`. The fallback routes by `origins`: a fallback-minted id is
  never looked up in the store, because a counter id may name a *different* stored row and reading it
  would hand back someone else's severity — ADR-0326's mis-routed resolve in a new shape. The `-pg`
  implementation **throws** on an unparseable row rather than answering null, because null means no
  row ever held the id while a parse failure means one did and has been edited into a state the
  contract forbids and a CHECK permits (ADR-0289).
- `packages/notification-providers/src/retry-after.ts` — the numeric-shape guard is load-bearing, not
  theoretical: `Date.parse("-5")`, `("+5")` and `("1.5")` all return a date in 2001, so without
  `/^\d+$/` first a malformed delta becomes a decades-long wait.
- `packages/notification-providers/src/fcm-token.ts` — an **EC** key passes every textual check and
  `createSign("RSA-SHA256")` signs with it anyway (the name selects the digest; node takes the
  algorithm from the key), producing a valid ECDSA JWT that Google refuses as `invalid_grant`. It is a
  boot refusal via `asymmetricKeyType`. No error message may contain key material, pinned by tests
  that search for a 24-character window of the key's base64 body.
- `packages/notification-providers/src/push-fcm.ts` — `fcmRefusedTheCredential(status, code)` is one
  definition with two readers. Deriving it from the resulting `errorCode` instead was wrong and a test
  caught it: the code carries the provider's own status suffix, so `PERMISSION_DENIED` yields
  `fcm_permission_denied` and a comparison against `fcm_not_authorized` matched none of the suffixed
  cases, which is every case FCM actually names.
- `packages/tenant-lifecycle-pg/src/tombstone-store.ts` — `scanAll` keysets on `tombstone_id`, which
  is NOT NULL and unique-constrained, so the ordering is total. `deleted_at` was rejected because two
  rows can share it and a tie makes a sweep re-read or step over a row at every page boundary — and
  the skipped row is one nothing else verifies. `chain_sequence_number` is unusable: nullable for
  pre-anchoring rows. `OFFSET` was rejected because a mid-sweep insert shifts later pages.
- `apps/operate-server/src/node.ts` — `notePage` / `resolveAndNote`, `requireEmitter`, the two
  unanchored-rows warnings, the FCM wiring and the sweep's findings sink.

**Verified live** against a throwaway Postgres and the real server:

- A `sev2` SLO incident with no affected tenant: the audit row is refused —
  `page has no tenant scope and meta.audit_log.tenant_id is NOT NULL` — and the timeline note lands
  anyway, reading `paged 1/1 over pagerduty_phone` with `reference: "INC-2026-0007"`. With the sink
  down the same path recorded `PAGED NOBODY — 0/1 over pagerduty_phone`, which is the line an
  incident review looks for.
- The tombstone sweep walked the table in pages of three and found a real unreferenced tamper:
  `tomb_live0003abcd [unreferenced] … scope_tampered, scope_disagrees_with_attestations`. The cursor
  advanced across three pages and ended.
- The partial index: planned as one `create_index` step, applied, and
  `pg_indexes` reports `… WHERE (related_deletion_request_id IS NOT NULL)`. A second plan is empty,
  so ADR-0292's deparse comparison matches the predicate. `enable_seqscan=off` shows
  `Index Scan using idx_tenant_tombstones_related_request`.
- Booting with `--audit-read-routes --tenant-erasure-routes` and **no** `--audit-chain-config`: both
  new warnings fire, both surfaces mount, `GET /v1/audit/entries` answers 200, and its own read lands
  in `meta.audit_log` with `chain_entry_hash IS NULL` — exactly what the warning says, where before
  the degradation was silent and the branch that was supposed to catch it could never fire.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A tombstone-sweep finding is reported, not escalated. The deletion escalator's episode key is `deletion_evidence:<requestId>` and these findings may have no request; a tombstone-keyed episode is a real decision, because a tampered tombstone that *is* referenced would otherwise declare twice for one fact. | amoufaq5 | 2026-11-30 |
| The sweep's coverage is a lap, and nothing reports how long a lap takes or whether one completed. | amoufaq5 | 2026-12-31 |
| `appendPagedNote` bypasses `PersistentIncidentEngine.apply`, so the store's `assertAppendOnly` check does not cover it. | amoufaq5 | 2026-12-31 |
| `PostgresIncidentStore` has no injectable clock, so a note with no `at` reads the wall clock rather than a `Clock`. | amoufaq5 | 2026-12-31 |
| The retry still does not jitter or back off, and `Retry-After` is read only from a *response* — a sender that throws (timeout, DNS) has no instruction and falls back to the policy delay. | amoufaq5 | 2026-12-31 |
| GKE metadata-server credentials are not implemented; only the service-account route is. | amoufaq5 | 2026-12-31 |
| `TwilioVoiceSender` is still not built from the environment. | amoufaq5 | 2026-12-31 |

## References

- RFC 9110 §10.2.3 (`Retry-After`), Google OAuth2 service-account JWT flow, FCM HTTP v1.
- ADR-0326 (a page that closes itself — this closes its six open questions), ADR-0325, ADR-0324,
  ADR-0323 (the tamper the chain cannot see), ADR-0322, ADR-0313, ADR-0310, ADR-0304, ADR-0301,
  ADR-0293, ADR-0292, ADR-0289, ADR-0288.
