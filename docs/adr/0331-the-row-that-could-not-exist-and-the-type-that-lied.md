# ADR-0331: The row that could not exist, and the type that lied

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-05 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0286, ADR-0289, ADR-0290, ADR-0292, ADR-0299, ADR-0307, ADR-0309, ADR-0312, ADR-0313, ADR-0323, ADR-0327, ADR-0328, ADR-0329, ADR-0330 |

## Context

This increment set out to close the follow-ups ADR-0329 and ADR-0330 left open. What it
found instead, five times over, is that each of those follow-ups was an *instance* of a
defect class whose other members had never been looked for — and that in four of the five
the honest fix sits one level up from where the pain was felt.

### 1. A fact about the deployment had nowhere to live

`meta.audit_log.tenant_id` was `NOT NULL` with a foreign key to `meta.tenants`. Three
escalation paths produce findings that cannot honestly name a tenant: an SLO surface is not
a tenant, the platform forensic chain has none, and a sweep that walks every tenant's proofs
is about the walk rather than about a row. So each of them wrote **nothing at all**. The row
was not merely unwritten, it was *structurally impossible* — which is why ADR-0327 had to
put a page on the incident's timeline instead, and why "this cannot be recorded" was stated
as a standing constraint in four separate places rather than fixed in one.

ADR-0313 had already split this table's single RLS policy into an isolation policy plus a
`SELECT`-only platform read, on the sharp reasoning that on an `ALL`-scope policy the
`USING` expression also serves as the `WITH CHECK`, so a combined form would let an elevated
*reader* forge an entry into another tenant's chain. That reasoning was right and the fix
held. What nobody did was ask how many other tables had the shape it describes.

**They number 31.** Every one of them carries exactly one `ALL`-scope policy whose predicate
is `tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true),
'')::UUID`, and **not one declares a `command`**. On every one, `tenant_id IS NULL`
satisfies the `WITH CHECK` unconditionally, so any tenant session can insert, update or
delete a *platform-wide* row. The list includes `crypto_keys`, `sso_providers`,
`feature_flag_kill_switches`, `notification_templates`, `certification_reports`,
`workflow_definitions`, `forensic_chain_entries` and `forensic_chain_checkpoints`. Confirmed
live as a non-owner role on the forensic chain: a tenant session appended a platform-scope
entry (`INSERT 0 1`), and the next verification reported `integrity BROKEN at 4, signatures
INVALID`. A tenant can make the platform chain read compromised on demand — which is the
alarm the entire forensics stack exists to raise.

### 2. The reconciler's newest capability paid for itself immediately

ADR-0330 started comparing column-level CHECK expressions, having found 765 of them that
were declared and never compared. Within this increment that machinery earned its place
three times: it made a widened `tenant_tombstones.proof_version` CHECK *visible* as
`constraint_needs_validation` with the exact SQL (rather than silently diverging), and it
made two cardinality floors on `meta.workflow_definitions` cheap enough to be worth
declaring at all.

### 3. node-postgres has never returned what the row types said

ADR-0330 fixed `instance-store.ts`, where `TIMESTAMPTZ` comes back as a `Date` and the
drift comparison therefore reported drift on every healthy instance. That was treated as an
instance. It is a class, and measuring it against a real cluster produced a table that
contradicts recollection in several places: `DATE` parses to **local** midnight (so
`toISOString().slice(0,10)` answers `2026-01-31` under `TZ=Asia/Tokyo` for
`'2026-02-01'::date`), `NUMERIC` and `BIGINT` come back as **strings**, `INTERVAL` becomes a
`PostgresInterval` whose `String()` is `[object Object]`, and — the fact that turned out to
matter most — **Postgres refuses to parse its own `Date.toString()`**.

That last one is what makes this more than a type lie. `ColumnMappedEntityStore.rowToRecord`
passed column values through raw, so a `datetime` field came out as a `Date`; `keysetOf`
builds a cursor component with `String(value)`; the next page binds it back with a
`::TIMESTAMPTZ` cast. Reproduced live: page 1 returns records, the cursor decodes to
`{"k":["Fri Jan 02 2026 03:04:05 GMT+0000 (Coordinated Universal Time)"],…}`, and **page 2
raises `invalid input syntax for type timestamp with time zone`**. Twenty-one pack entities
carry the `auditable` trait, plus 43 explicit `date` and 23 `datetime` fields. The two
implementations of one `EntityStore` interface disagreed: `PostgresEntityStore` reads the
same value out of JSONB, where it is already the ISO text the write put there, and *its*
page 2 works.

### 4. "Where do workflow definitions come from?" had no answer, so nothing ran

ADR-0330 established that the workflow orchestration layer is unreachable from the deployed
server: no `WorkflowEngine` is instantiated and `meta.workflow_definitions` has no writer.
ADR-0329 built instance cancellation, its contract, its fence columns and its route — and
then this binary had to **refuse `--workflow-cancel-role` outright**, because a route over an
empty definition map would answer `unknown_instance` for every instance.

### 4b. The chain's readers trusted RLS, and an owner bypasses it

`PostgresChainLogReader`'s `loadChain`, `tail`, `loadFrom` and `tailWithin` ran bare
`SELECT … FROM meta.forensic_chain_entries` and relied on the policy alone. **A table's owner
bypasses its policies**, and connecting as the owner is an ordinary deployment. Observed live
as the owner: `loadChain(null)` returned a *tenant's* entries interleaved with the platform's,
and the tenant's first-ever chain entry was assigned `sequence_number = 1` because `tailWithin`
saw the platform chain's `0` as the global maximum. So in such a deployment every scope's
`priorEntryHash` is taken from another scope's last entry and `verify()` reports a sequence gap
on perfectly healthy data — the forensics stack crying wolf about itself.

### 5. One line in the auth wiring, three defects downstream

`buildPrincipalWiring` hardcoded `principalKind: "user"` for every API key, and
`parseApiKeySpec` defaulted the optional fourth field to a single shared placeholder UUID. So
a bare `key:role:tenant` credential claimed to be a person who does not exist, and *every*
such key claimed to be the **same** person.

### 6. "Executed 9, failed 0" is not "the schema is correct"

A reconciliation step can only be planned against the schema as it was *before* the pass, so
a plan does not always converge in one. `apply` reported a clean run while the schema was
still wrong, and an operator reads the former as the latter.

## Decision

**Where a defect was found as an instance, fix the class — but only as far as the evidence
reaches, and name the remainder with a count.**

Concretely:

1. **`meta.audit_log.tenant_id` is nullable, and NULL means platform scope.** The foreign
   key stays (a NULL satisfies it; a non-NULL must still name a real tenant). A **third**,
   `INSERT`-scoped policy keyed on its **own** GUC `app.platform_audit_write` is the only
   route to such a row. Three decisions, each load-bearing: its own GUC, because
   `app.platform_audit` is the cross-tenant *read* grant and the population holding it is the
   one whose conduct these rows record; `INSERT`-scoped, because such a policy carries only
   `WITH CHECK` and so cannot serve an `UPDATE`'s or `DELETE`'s `USING`, keeping the table
   append-only at the policy as well as in `PostgresAuditEmitter`; and `tenant_id IS NULL`
   *inside* the check, so holding the write elevation buys no access to any tenant's chain.
   `canonicalAuditEntryPayload` needed **no** version bump — verified by pinning sha256
   digests of the published build's output before the change and asserting them after.
2. **`meta.forensic_chain_entries` and `meta.forensic_chain_checkpoints` get the same split**,
   on the same grant — the chain anchors the audit trail, so appending to one and appending
   to the other are one privilege and a second flag would be two things to configure for it.
   `PostgresChainLogStore` and `PostgresChainCheckpointStore` set it per platform append,
   transaction-locally. These two are fixed rather than reported because their hole was
   *demonstrated* and their answer is unambiguous: both tables are append-only, so
   `INSERT`-only is exactly right.
3. **The remaining 29 tables are reported, not swept.** The correct split differs per table:
   an append-only table wants `INSERT`-only, while mutable platform configuration
   (`feature_flags`, `workflow_definitions`, the plan catalog) needs an elevated `UPDATE`
   too, and landing 29 unverified policy changes that govern who may write platform
   configuration would be worse than naming the class. `meta.audit_integrity_verdicts` is
   left in this group deliberately although ADR-0313 named it: splitting it means narrowing
   its *isolation* policy from `ALL` to `SELECT`, which is a different and more consequential
   edit than adding two policies beside one.
4. **Splitting a permissive policy is not reconcilable in one pass, and the catalog cannot
   say so.** `planSchemaReconciliation` creates the three new policies and **refuses to drop
   the old permissive one**, because dropping a policy loosens access (ADR-0290's invariant)
   and `allowLoosening` reaches foreign keys only. Permissive policies are **OR'd**, so until
   that `DROP` runs by hand the split buys *nothing* — the old `tenant_id IS NULL OR …` still
   satisfies every `WITH CHECK`. The plan hands over the exact SQL, and this is now the second
   migration step in this increment that an operator must run themselves.
5. **One normaliser, in `kernel-pg`'s `connection.ts`** — `isoInstant`,
   `requireIsoInstant`, `isoCalendarDate` — in the module that defines `PgQueryResult`, i.e.
   the interface whose rows these functions describe. Four real defects fixed with it
   (`column-store.ts`, `idempotency-store.ts`, `route-registry.ts`, `event-log.ts`), one
   latent (`api-gateway-pg`'s replayer). `NUMERIC` and `INTERVAL` are **deliberately not**
   normalised: converting a `NUMERIC(38,10)` to a JS number is lossy by construction, which
   is *why* node-postgres returns a string, so the fix is a decision about a `decimal`
   field's wire type rather than a sweep.
6. **Workflow definitions are authored, not compiled from a manifest.** Four pieces of
   evidence, three of them from this codebase: every manifest workflow in the catalog is
   `entityLifecycle` (19 in core, 1 in healthcare, **zero** orchestration or scheduled), so a
   compiler would have had zero valid inputs and would have given 20 state machines a second
   executor and a second writer of the entity's state field; the other two kinds carry
   `z.unknown()` and so are not compilable; `createdBy` wants a UUID *and*
   `publishedBy !== createdBy`, so a compiler would need **two** fabricated constants that
   differ from each other, satisfying the four-eyes rule with invented values, which is its
   exact inverse; and `DEFINITION_TRANSITIONS` makes `published` reachable only via
   `in_review`. No contract change. `surveyManifestWorkflows` is the other half of the
   decision: under a compiler an unserved workflow would have been a *wrong* definition,
   under authoring it is an *absent* one, so every manifest workflow is classified and named.
7. **An API key that names no principal is a `service_account`.** The id collision is **not**
   fixable in the spec — a bare `key:role:tenant` does not carry the information to tell two
   keys apart, and the one thing that would is the credential itself, which must not be hashed
   into an id that lands in `meta.audit_log`, because that turns an audit reader into an
   offline brute-forcer. So the collision is *declared* rather than papered over, and
   `principalKind` is the declaration.
8. **`apply` re-plans after a clean pass** and reports what is still outstanding;
   `remaining.statements.length === 0` is the convergence claim. `standingDifferences` decides
   which of the two plans may be *printed*, because the pre-apply plan's statements have all
   run by then.
9. **Per-route request-body limits** (`--max-request-body-route <prefix>=<size>`), matched by
   path prefix — not by the gateway's route template, because the limit must be chosen before
   the body is read and route matching happens after it.
10. **The read-state routes exist**, closing ADR-0309's tables-with-no-writer. The viewer is
   always the credential; a body naming one is **refused**, not ignored, because ignoring it
   would let a client believe it marked somebody else's notice read.

## Alternatives considered

- **Option A: give `meta.audit_log` a sentinel tenant row for "the platform".**
  - **Pros:** no schema change; the `NOT NULL` and the foreign key both stay; every existing
    reader works unaltered.
  - **Cons:** the sentinel is a row in `meta.tenants`, so it appears in every tenant listing,
    every billing sweep, every deletion scan and every per-tenant integrity pass; and RLS
    would let anyone who can set that tenant's context write the platform's own trail.
  - **Why not:** it makes the platform a tenant in order to say that something is not about a
    tenant. ADR-0328's rule applies — a value invented to satisfy a constraint is the thing
    that later reads as a fact.

- **Option B: a separate `meta.platform_audit_log` table.**
  - **Pros:** no change to a table 112 others reference by example; no policy to get wrong;
    the append-only guarantee is trivially preserved.
  - **Cons:** two trails to verify, two to anchor, two to sweep, two to keep in step; and
    `proveScopeIntegrity`, `verifyAuditAnchors` and the three escalators would each need a
    second code path. The forensic chain already supports a null scope, so the *chain* would
    not have been split — only its index.
  - **Why not:** the trail is one trail. A platform row is a fact in the same ledger, and the
    one question that matters — "has anything in this deployment's record been altered?" —
    should not have to be asked twice and then reconciled.

- **Option C: reuse `app.platform_audit` for the platform write.**
  - **Pros:** one flag to configure; one privilege to grant; no new constant.
  - **Cons:** a reader of the trail could forge an entry claiming a page was delivered.
  - **Why not:** this is ADR-0313's hole arriving from the other direction, and the population
    holding the read grant is precisely the population whose conduct these rows record.
    Verified live: read elevation → INSERT refused, for a tenant row and a platform row alike.

- **Option D: sweep all 31 policies in this increment.**
  - **Pros:** closes a real, demonstrated, broad hole in one pass; a future reader does not
    have to rediscover the count.
  - **Cons:** the correct decomposition is not uniform. An `INSERT`-only platform policy makes
    platform rows immutable-by-RLS, which is right for `audit_log` and the chain and **wrong**
    for `feature_flags` and `workflow_definitions`, whose platform-wide rows are updated in
    normal operation. Getting it wrong on those breaks platform configuration writes in a way
    that fails closed and silently.
  - **Why not:** 31 policy changes governing who may write platform configuration, landed in
    one increment with per-table live verification for two of them, is not a sweep — it is a
    guess with a large blast radius. Named with a count and a recommended shape instead.

- **Option D2: write the chain's scope predicate as `tenant_id IS NOT DISTINCT FROM $1`.**
  - **Pros:** one bound parameter and one code path for both scopes; it is the only operator
    that matches NULL to NULL, which is exactly the semantics wanted.
  - **Cons:** measured against 45k entries, it is **not an indexable operator** — with
    `enable_seqscan` off Postgres still has no index path and takes the sequential scan
    anyway (16 ms, 355 ms under the disable penalty), where `tenant_id = $1` is an index scan
    on `idx_forensic_chain_entries_tenant_seq` at **0.09 ms**.
  - **Why not:** this read runs on *every append*, to find the tail to chain onto, against a
    table that only grows. `scopeFilter` branches instead — `tenant_id IS NULL` is itself
    indexable, so both arms keep an index. The single code path was not worth two orders of
    magnitude on the hot path.

- **Option E: normalise `NUMERIC` to a JS number alongside the timestamps.**
  - **Pros:** `ColumnMappedEntityStore` would stop disagreeing with `PostgresEntityStore` on
    the 92 `decimal` fields across the packs, where one returns `"10.25"` and the other
    `10.25`.
  - **Cons:** lossy by construction for `NUMERIC(38,10)`, which is exactly why node-postgres
    returns a string in the first place.
  - **Why not:** it is a decision about a `decimal` field's wire type — number, or string with
    the contract changed to match — and not a normalisation. `readColumn` is now the one place
    that decision would land.

- **Option F: compile `WorkflowDefinition` records from the manifest's `workflows`.**
  - **Pros:** a tenant's manifest would be the single source of truth; no authoring surface,
    no grants, no four-eyes flow to build.
  - **Cons:** zero valid inputs in the entire catalog; two of the three manifest workflow kinds
    carry `z.unknown()`; and the compiler would have to fabricate both `createdBy` and a
    `publishedBy` that differs from it.
  - **Why not:** it would have given 20 existing `entityLifecycle` state machines a second
    executor, a second audit trail and a second writer of the entity's state field — and
    `operate-runtime` already derives the transition operations, the UI state field and the
    list-query state column from those same declarations.

- **Option G: let `--workflow-cancel-role` mount against whatever definitions exist.**
  - **Pros:** no refusal; the flag does something.
  - **Cons:** under RLS as a non-owner role with no tenant context the load sees only
    platform-wide rows, so a deployment whose definitions are all tenant-scoped gets an empty
    map — and a 404 then reads as "no such instance" rather than "this server loaded no
    definitions".
  - **Why not:** half-adopted. The flag now refuses only on the memory store (where the tables
    do not exist at all) and **warns loudly** when the map comes back empty. ADR-0329's rule
    stands: a surface that degrades rather than refusing has to say so out loud.

- **Option H: derive an API key's principal id from the key, so two keys differ.**
  - **Pros:** closes the collision properly; stable across restarts; no new configuration.
  - **Cons:** the id is then a deterministic function of a credential, and it lands in
    `meta.audit_log`, where a principal id is not treated as a secret. A weak key becomes
    *offline* brute-forceable from the audit trail rather than online-guessable against the
    gateway, which has rate limiting.
  - **Why not:** it trades an attribution defect for a credential-disclosure one.

## Consequences

- **Positive.** Three escalators that recorded nothing now leave anchored rows, verified live
  end to end including the ADR-0286 contrast: a tampered platform row reports `hash_mismatch`
  and `COMPROMISED` while the chain's own `verify()` still answers `{"valid":true}`. The
  column store's keyset pagination works past page 1 for `datetime`, `date` and `decimal`
  sorts. The workflow engine is mounted and a workflow definition can be published, with
  four-eyes enforced at three layers — contract, a SQL `UPDATE` predicate, and now a table
  CHECK. A tenant's notification read state is recordable over HTTP for the first time since
  ADR-0309 declared the tables. `apply` distinguishes "it ran" from "it is done".
- **Negative.** 29 tables keep the policy shape whose exploit was demonstrated on the
  thirty-first. `proveScopeIntegrity`'s platform half runs only when `--integrity-proof-config`
  sets `includePlatform: true`, which still defaults to `false`, so a deployment that does not
  opt in writes platform rows that nothing verifies — and flipping that default without the
  matching `--checkpoint-config` one would leave the platform scope's truncation check without
  a witness (ADR-0287), so it is one decision across two configs and it is not taken here. A
  `date` field served from a column-mapped tenant now returns `"2026-02-02"` rather than
  `"2026-02-02T00:00:00.000Z"`; that matches both the write and the JSONB store, and
  `operate-web`'s `formatDate` regex-matches the leading `YYYY-MM-DD`, but it is a visible
  wire change reasoned from the HTML spec and the source rather than confirmed in a browser.
  Every deployment holding a tombstone must run the `proof_version` CHECK widening by hand,
  because the reconciler cannot tell a widening from a narrowing on a populated table.
- **Neutral.** `meta.audit_log` now has three policies and one of them is `INSERT`-scoped —
  the first in the catalog, giving ADR-0298's `command` field its second and third user.
  `RlsPolicy.using` became optional, because Postgres **refuses**
  `CREATE POLICY … FOR INSERT USING (…)`; `emitRlsPolicy` throws when a policy declares
  neither clause, since that is legal SQL meaning *allow everything* and the one thing a
  policy must never say by omission is yes. All 107 pre-existing policies emit byte-identically.
- **Reversibility.** The nullable column is a one-statement revert while no platform row
  exists and unrevertable afterwards without deleting the deployment's own records. The
  normaliser, the authored-definition store, the read-state routes and the per-route body
  limits are each additive and removable. The `principalKind` change is one line, but
  reverting it reopens three defects.

## Implementation notes

- `meta.audit_log` is the only table changed in the catalog for strand 1;
  `meta.workflow_definitions` gained three table CHECKs, two column CHECKs and a **partial**
  unique index (`WHERE tenant_id IS NULL`) because the DDL vocabulary has no spelling for
  `UNIQUE NULLS NOT DISTINCT` — ADR-0302's rule — and `tenant_id IS NULL` is IMMUTABLE, so
  Postgres accepts it as an index predicate. All eight statements plan and apply; nothing is
  reported `unreconciled`. Verified against a live cluster, which then re-planned
  **"nothing to do — the live schema matches the catalog"**.
- The engine's definition map is keyed by `definitionId`, traced rather than chosen:
  `startInstance` writes `definitionId` into the `instance_started` payload and *every* later
  lookup — timer firing, signal delivery, activity execution, compensation, cancellation,
  parent resolution — reads it back. Keying by `definitionKey` would make `startInstance`
  succeed and every subsequent lookup miss. `loadEngineDefinitions` loads **every** status,
  because a missing definition makes the engine go quiet rather than raise, so a map narrowed
  to `published` would silently strand in-flight instances of a `deprecated` definition.
- `routeBodyLimitFor` matches on a path prefix, longest wins, with query and fragment cut
  before matching. A relative prefix and a duplicate prefix are refused at parse time. The
  Fetch/Workers adapter needed `pathOfRequestUrl`, because `request.url` is absolute there.
- The read-state backfill grant is **additive** on `--read-state-role`, not a substitute: the
  base grant is checked first, so a backfill role missing from it is refused there and the
  backfill grant never comes into play — which reads as the backfill grant not working. The
  CLI says so at boot instead.
- `--read-state-routes` had to join the condition that constructs the notification store.
  Omitted, it mounted nothing and warned that it "requires a Postgres store" on a server
  started with `--store pg` — a refusal naming the wrong cause, which is worse than no
  refusal. Found by booting the real binary; the two conditions now give two messages.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Which of the remaining 29 `tenant_id IS NULL OR …` policies want `INSERT`-only and which need an elevated `UPDATE`? | Platform | 2026-11-30 |
| Should `includePlatform` default to `true` on both `--integrity-proof-config` and `--checkpoint-config`, together? | Platform | 2026-11-15 |
| Is a `decimal` field's wire type a number or a string, given `NUMERIC(38,10)` cannot be both exact and a JS number? | Platform | 2026-12-15 |
| Should an audit read that crosses tenants stay filed in the reader's own tenant now that platform scope exists? | Platform | 2026-11-30 |

## References

- ADR-0313 — the policy split this generalises, and the `ALL`-scope `USING`-as-`WITH CHECK` reasoning.
- ADR-0330 — the column-CHECK comparison that made three of this increment's changes visible, and the `Date`-vs-string instance this treats as a class.
- ADR-0307 — `build` and `typecheck` read different configs; ADR-0329 added the `dist/` form of the same lesson. Both applied again here.
- ADR-0309 — the read-state tables declared with no writer.
- ADR-0328 — "a default is applied to silence", applied to `readThroughAt` and to the API-key principal.
- RFC 9110 §10.2.3 — `Retry-After`, both forms (ADR-0327's retry, unchanged here).
- PostgreSQL: `CREATE POLICY` (`USING` refused on `FOR INSERT`; `ALL`-scope `USING` also serving as `WITH CHECK`), `pg_policy.polcmd`, partial unique indexes, and `node-postgres` type parsing.

## Addendum (2026-10-05): the retention claim entered the signed bytes here, and this document omitted it

`crossengin.tombstone.content.v3` shipped in **this** increment's commit — 1,533 lines across ten
files in `tenant-lifecycle` and `tenant-lifecycle-pg` — and the text above does not mention it. The
omission was mine: the lane that built it reported the meta-schema column it needed, I landed that
column, and I then wrote this ADR from the other strands. CLAUDE.md consequently went on describing
the gap as open in the same commit that closed it, which is exactly the shape-versus-history drift
that file warns about. Recorded here rather than in a later ADR because the decision belongs with
the code that carries it.

**The defect.** ADR-0330 added the `erased_and_retained` outcome, so a subsystem could say it
destroyed some data and lawfully kept the rest. But `contentManifestSha256` committed only to the
composed `DeletionScope`: `retainedReason`, `retainedDataReference` and `retainedObligations` were on
the record and in **neither** digest. A stored proof's retention prose could be edited with both
digests and the chain entry byte-identical — ADR-0323's `scope_tampered` in a third place, and on the
one sentence a regulator reads ("we lawfully retained your invoices under a seven-year obligation").

**The decision.** A third domain tag, `crossengin.tombstone.content.v3\n`, carrying
`retentionClaim: { obligations, retainedReason, retainedDataReference }` — sorted and deduped, with
**explicit `null`** rather than an omitted key, because `canonicalStringify` drops `undefined` and an
omitted key would render the empty claim and a claim with its prose *stripped* identically. The
retained side carries **no figure of any kind**: a `DeletionScope`'s numbers mean "this was
destroyed", so a number beside them would be read into that total.
`crossengin.tombstone.proof.v1` is unchanged for all three versions, since the proof payload commits
to `contentManifestSha256`, which is version-bound by its own tag — so the chain transitively
witnesses the claim without the proof's own bytes moving. A verifier reads `proofVersion` and
**never infers** it from whether a claim is attached: `DECLARATION_BEARING_PROOF_VERSIONS` and
`RETENTION_BEARING_PROOF_VERSIONS` are membership lists rather than a `>= "v2"` ordering test, and
`contentManifestSubjectOf` pairs version↔payload in **both** directions, because an inference would
read a *deleted* claim as an older record — the tamper that covers its own tracks (ADR-0329's rule).
v3 is the default for every capabilities-path assembly, not only for retentions, since a conditional
version would express "nothing retained" by the absence of a tag.

**"Nothing retained" versus "retention not covered"** are separated in three places that must agree.
In the bytes, a v3 record always carries `retentionClaim`, and `{"obligations":[], null, null}` is a
*signed assertion* that nothing was kept — a sentence no v1 or v2 digest can express. In storage,
`retained_obligations` is nullable with **no default**: `NULL` means "these bytes do not cover a
claim", `'[]'::jsonb` means "signed as nothing kept", and a `DEFAULT '[]'` would make every pre-v3
row read back as a signed empty claim (ADR-0328). In the reader, `readRetentionClaim` is a two-state
union whose `unknown_not_in_proof` arm carries **no list at all**, so there is no empty array for a
caller to mistake for "nothing retained".

**Verified.** v1 and v2 bytes are byte-identical across the change, proved by transpiling
`tombstone-proof.ts` from ADR-0329's commit and running the *old* algorithm: v1 content
`7e7f8974…94383`, v2 content `979750b9…be2f07`, and the proof tag over each of the three content
digests — including the v3 one the old code cannot compute — all matching the new implementation.
The same cross-check ran against the database, recomputing both digests of live v1 and v2 rows.
Live, the tamper is reproduced and closed in one transcript: editing a v3 record's retention prose
flips `contentManifestOk` to false while `proofSha256`, `chain_entry_hash` and the chain's own
`verify()` stay untouched, and **the same edit on v1 and v2 rows leaves both digests verifying** —
which is the defect, demonstrated rather than asserted. Note that `tombstoneMatchesAttestations`
deliberately does not compare the prose (wording and array-order dependence would false-positive
into a `sev1` page), so for these fields the v3 digest is the *only* detector.

**What it leaves.** v1 and v2 records on file are permanently unprotected in this respect; nothing
can retrofit them, and re-signing them under v3 would forge the one alarm the chain cannot raise.
The claim is signed but the **per-table obligation pairing** is not: `sharedTableRetention` flattens
to a list of obligations plus one `dataReference` string, so a proof naming two obligations over
three tables does not say which table is under which. The erasure's own report has the pairing and
the attestation contract has nowhere to put it; closing that means a structured
`retainedData: [{table, obligation}]`, i.e. a **v4** tag, and it is vacuous today because both
statutory entries share one obligation. Also found while verifying this: ADR-0330's expectation that
a second obligation on the pure `retained` outcome would be "refused by `DeletionAttestationSchema`"
is **wrong** — `retention.obligations[0]` builds a perfectly valid attestation, so the second
obligation was never written down rather than rejected, and the proof would name one lawful basis for
data held under two. That is now a loud refusal in `sharedTableErasureAttestation`.
