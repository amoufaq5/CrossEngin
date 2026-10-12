# ADR-0332: The defects that were silences

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-05 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0286, ADR-0287, ADR-0289, ADR-0290, ADR-0292, ADR-0302, ADR-0309, ADR-0310, ADR-0313, ADR-0315, ADR-0317, ADR-0320, ADR-0327, ADR-0328, ADR-0329, ADR-0330, ADR-0331 |

## Context

ADR-0331 closed its increment by observing that **a defect found once is usually a class**. This
increment took that as the brief and found something narrower and more uncomfortable: nearly every
defect it turned up was a *silence* rather than a wrong answer. Something was not recorded, not
compared, not searched, not delivered — and the surface reported success.

### 0. Twenty-nine tables let any tenant session write a platform-wide row

ADR-0313 found this shape on `meta.audit_log` and split that one table's policy. ADR-0331 extended
the fix to the two forensic-chain tables and **counted the rest: 29**. Each carries a single
`ALL`-scope policy whose predicate is
`tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID`,
and **not one declares a `command`** — so `tenant_id IS NULL` satisfies the `WITH CHECK`
unconditionally, because on an `ALL`-scope policy the `USING` expression *is* the `WITH CHECK`.

Demonstrated live as a non-owner role, with the permissive policy in place: three statements from a
plain tenant session, three successes — `INSERT 0 1` of a platform-wide quota definition, `UPDATE 1`
of the platform flag that gates JWT audience checking, and `DELETE 1` of it. The list includes
`crypto_keys`, `sso_providers`, `feature_flag_kill_switches`, `notification_templates`,
`certification_reports` and `workflow_definitions`.

### 1. One signal submit delivered N and stored one

`WorkflowEngine.submitSignal` minted `signalId` **outside** the match loop and then appended a
`signal_received` event carrying that same id to each matched instance.
`meta.workflow_signals.signal_id` is UNIQUE, so N deliveries collapsed to **one row**, attributed to
whichever instance was projected last. The instance that lost the attribution then had no row, so
`WorkflowReplayer.verifyInstance` reported **drift on healthy data** — the second symptom of the
first defect, and the kind of false alarm that teaches an operator to ignore the detector.

Separately, `submitSignal`'s idempotency was a process-local `Set` and `input.idempotencyKey` reached
neither the event payload nor the row. So `meta.workflow_signals`' unique index on it had **never
enforced anything**, dedup did not survive a restart or reach a second replica, and a signal declared
`exactly_once_idempotent` persisted with a NULL key — a row its own contract forbids and the CHECK
permits, which is ADR-0289's class exactly.

### 2. A `decimal` field had no wire type, and two stores disagreed about it

ADR-0331 measured that `NUMERIC` comes back from node-postgres as a **string** and left the wire type
undecided. The cost was not the type mismatch. Three sites in `operate-runtime`'s write effects used
`typeof x === "number"` as a *presence* test, which answers **false** for every amount the typed store
serves. Against `ColumnMappedEntityStore`, today:

- `credit_amount` read as absent, so **a partial credit note silently became a full one** — in the
  document *and* in the general-ledger entry;
- a line's `tax_rate_pct` read as "no flat rate", so the line-level tax split silently fell back to
  the document split.

Those are wrong *postings* in a double-entry ledger, reachable now. And the store-side half of the fix
would have been **invisible on the one path a user actually drives**: both generic entity forms in
`operate-web` called `Number(draft)` before POSTing, destroying precision client-side before the wire
ever saw it.

### 3. Four source files were invisible to the repository's own search tooling

`operate-runtime/src/store.ts` contained a **literal NUL byte**, used as an `InMemoryEntityStore`
map-key separator. `file` reports such a file as `data`; grep and ripgrep classify it as binary and
decline to search it, reporting *no matches* rather than reporting a skip. It was found the hard way —
a grep for `keysetOf` returned nothing from the file that defines it. Three more had the same idiom:
`operate-runtime/src/sequences.ts`, `operate-server/src/audit-chain.ts`,
`operate-server/src/link-sweep.ts`.

### 4. The `fax` verdict was named and inert

ADR-0310 named `AnsweredBy: fax` and deliberately suppressed nothing, on ADR-0302's rule that a safety
record must never widen on an inference — `AnsweredBy` is a detector's guess from a few hundred
milliseconds of audio. ADR-0329 said closing it needs a consecutive count, i.e. state a pure module
does not hold. Until then a number that was unambiguously a fax machine consumed a voice notification
on every attempt, forever.

### 5. A stall episode could not say which kind it was

ADR-0330's sweep-stall escalation writes its title and detail once at declaration, and an adoption
writes nothing. So an episode that began `no_pages` (the store is unreachable) and became
`pinned_cursor` (pages arrive, the position does not move) read as `no_pages` on the incident forever,
with only the undeduped log line carrying the current kind — and the two send a responder to different
halves of the system.

### 6. Platform rows were written and verified by nothing

ADR-0331 made a platform-scope audit row expressible and three escalators began writing them. But
`includePlatform` defaulted to `false` on both `--integrity-proof-config` and `--checkpoint-config`,
so a deployment that did not opt in was writing rows **nothing verified** — ADR-0327's "built,
correct, and read by nothing", in the one table where the integrity proof is the only detector there
is.

## Decision

**Where a surface reported success while recording nothing, make the silence impossible rather than
documenting it.** Concretely:

0. **The 29 policies are split, on two orthogonal axes.** *Shape* decides how many policies —
   **12 mutable** tables get four (isolation, `SELECT` platform read, `INSERT` platform write,
   `UPDATE` platform write) and **17 append-only** tables get three, so a platform row on an
   append-only table is immutable-by-RLS once written. *Grant* decides who, over **four** GUCs:
   `app.platform_audit_write` (3 tables, ADR-0331's, untouched), `app.platform_record_write` (17),
   `app.platform_config_write` (11) and `app.platform_key_write` (1). `DELETE` is reachable by **no
   policy on any of them**, because nothing in the codebase deletes a platform row — retirement is a
   status column in every one of these contracts, and the GDPR shared-table erasure deletes
   `tenant_id = $1` only, which the isolation policy still covers.

   The axes are orthogonal and conflating them was the first wrong turn: `quota_definitions` and
   `feature_flag_targeting_rules` are append-only in *shape* but sit on `config`, because a hard
   limit and a targeting rule each decide what the deployment permits; `dr_failover_executions` is
   mutable in shape but sits on `record`. One axis would have forced one of those wrong.

   **The grants are `PUBLIC`-scoped settings rather than role-narrowed, and that is forced.** A
   policy's `roles` list would have to name roles the catalog cannot know a deployment created —
   which is why no policy anywhere in `META_TABLES` narrows `roles`. What the split buys is therefore
   not an authorisation but a *declaration*: claiming a grant is a deliberate, transaction-local act
   by a session that knows which privilege it is exercising, rather than the ambient default of every
   tenant connection.

   **The narrowed isolation policy keeps its existing name.** `feature_flags_tenant_or_platform`
   stays that, with a narrowed predicate — which is what makes the whole split reconcilable in one
   pass: a policy under a known name with a changed definition is `replace_policy`, one
   `DROP …; CREATE …;` statement. A *renamed* one would have been `create_policy` plus a
   `policy_removed` refusal, and because permissive policies are **OR'd**, the split would have
   bought *nothing* until 29 hand-run drops landed — ADR-0331's two-table trap multiplied by
   fourteen. Measured twice: **99 steps, 0 unreconciled, zero manual SQL** against an
   already-migrated database, and **958 of 958 statements executed, 0 failed** on a fresh cluster
   taking the full bootstrap, with the immediate re-plan reporting *nothing to do* in both cases. The
   cost is a policy whose name no longer describes it, and there is no `renamedFrom` for a policy.

   The arithmetic that confirms the shape axis landed is the live policy census:
   **`ALL 114`, `SELECT 34`, `INSERT 32`, `UPDATE 12`** — twelve `UPDATE` arms and twelve mutable
   tables, so no append-only table gained one and no mutable table was left without.

1. **A signal id is minted per match**, and `submitSignal` returns `deliveries` rather than a single
   `signalId` — with N instances there is no such value. `deduplicated` returns **the first submit's
   deliveries**, not an empty list, because telling a retrying webhook that nothing matched is the one
   thing that is never true of a duplicate.
2. **The idempotency key is written to the receipt event and the row**, and a duplicate is answered
   from the database. `meta.workflow_signals`' unique constraint gains `instance_id` as a **fourth**
   column, because one delivery per instance is the natural key — `WorkflowSignal.instanceId` is
   singular and `matchSignalToInstance` returns one id. Submit-level dedup is unharmed because the old
   three-column form is the **left prefix** of the new index, which is what the deduplicator reads;
   a test pins that prefix, so the property making the fourth column free is itself protected.
3. **The deduplicator is a fast path and the log is the authority.** A deduplicator reads *before* the
   appends it guards, so each instance's own log is re-asked immediately before its receipt is
   appended. Without that second question two concurrent submits of one key both read "unseen", the
   loser appends a second receipt and its row is refused — leaving an instance whose projection **can
   never be rebuilt**, because every later `resyncInstance` re-hits the same conflict. A permanently
   unrepairable record from a transient race.
4. **A `decimal` crosses the wire as a canonical decimal string, uniformly, at every precision** — the
   exact text Postgres prints for `value::numeric(precision, scale)`. Enforced by one decorator
   (`withDecimalWireType`) applied in `compileOperateServer`, the single place holding both the store
   and the manifest, so no app wiring was needed and the write effects are covered by the same seam as
   a client request. Refusal is split by provenance: an over-scale literal from a **client** is a 422
   at validation, where it can still be fixed; a computed value is quantised at the store boundary,
   because refusing there would turn a correct tax computation into a 500.
5. **The NUL separators are spelled `\u0000`** — byte-identical at runtime, and the source is text
   again.
6. **A run of consecutive `fax` verdicts can suppress, opt-in**, over
   `meta.notification_fax_observations`. Permanent rather than bounded, and that is forced rather than
   chosen (see the alternatives). Off by default; a threshold of 1 is refused by name; a single
   answered call **deletes** the run rather than decrementing it, because an absent row and a run of
   zero are the same fact.
7. **A stall episode's kind is read back off its incident's timeline**, not remembered in the process,
   so a flip is detected after a restart and by a different replica and a note lands once per actual
   change rather than once per tick.
8. **`includePlatform` defaults to `true` on both configs, flipped together.** One without the other
   would be wrong rather than merely partial: the truncation check has no witness without a checkpoint
   (ADR-0287).

## Alternatives considered

- **Option A0: one platform-write grant for all 29 tables.**
  - **Pros:** one setting to configure; no boundary to argue.
  - **Cons:** the boundary test is "name a population that should hold one and not the other", and
    three pairs answer it immediately. **`audit` vs `key`** is the sharpest and is why `crypto_keys`
    gets a grant to itself: that table holds the public keys a chain entry's
    `signingKeyFingerprint` resolves against, so a session able to *both* append to the trail and
    register a key could re-sign a rewritten chain and have it verify — ADR-0313's rule exactly, a
    grant over the record must not reach the thing that validates the record. **`config` vs
    `record`** bites soonest: a DR drill scheduler that could also flip `gateway.strict_jwt_aud` is
    an authentication bypass. And **`key` vs `record`** is why `meta.crypto_audit` is `record`, not
    `key` — the population that may register a platform key is precisely the population whose
    conduct those rows record.
  - **Why not:** one grant would be a privilege nobody could scope, and 29 would be 29 things nobody
    configures correctly. Four, grouped by what the privilege *is*, each answers a sentence an
    operator can read.

- **Option A1: rename the narrowed isolation policy to `<table>_tenant_isolation`.**
  - **Pros:** the name would describe what the policy does, matching the three tables ADR-0331
    split.
  - **Cons:** a renamed policy is `create_policy` plus a `policy_removed` refusal, and
    `allowLoosening` reaches foreign keys only. Permissive policies are OR'd, so an operator would
    see "executed 99, failed 0" and believe the hole closed while every platform row stayed
    forgeable, until 29 hand-run `DROP POLICY` statements landed.
  - **Why not:** exactly the trap ADR-0331 documented on two tables, and it does not scale to
    twenty-nine. A misleading name is cheaper than a migration nobody completes.

- **Option A2: extend `allowLoosening` to reach policies**, so a rename could drop the old one.
  - **Pros:** the symmetry with a foreign key is tempting for ADR-0290's own reason — neither drop
    can fail against existing rows.
  - **Cons:** a constraint is a rule *about* data; a policy *is* the access control. The failure
    modes are not comparable — a wrongly dropped foreign key lets a bad row in, a wrongly dropped
    policy lets every tenant read every other tenant.
  - **Why not:** `replace_policy` already removes a policy only where it writes the replacement in
    the same statement, and that invariant is worth more than the convenience. The split makes it
    moot anyway.

- **Option A3: drop the platform read arm on tables that have no platform writer.**
  - **Pros:** 14 of the 29 have no store at all — declared and never written, the ADR-0300 class —
    so an arm nothing claims is capability without a caller.
  - **Cons:** `tenant_id` is nullable on all 29 and every corresponding contract declares
    `tenantId: …nullable()`, so the platform arm is *intended* everywhere. `notification_templates`
    is the closest case — both its stores refuse `tenantId === null` outright — yet its read path
    resolves `(tenant_id = $1 OR tenant_id IS NULL)` and its own comment says a platform row is
    "authored by an operator".
  - **Why not:** it silently removes a documented intent. The arms are given instead, gated on a GUC
    nothing sets — strictly narrower than today in every direction, and reversible by a deployment
    that wants to seed as the owner.

- **Option A: add `correlation_key` to the signal dedup key.**
  - **Pros:** would make `send_signal`'s literal `idempotencyKey` parameter "work" — many instances
    each sending one constant key under a different correlation key.
  - **Cons:** an idempotency key is the *client's* identity for a request, so a retry must be detected
    **even when the body differs**; `correlation_key` is body-derived (`correlationExtractor.extract`),
    so a retry whose correlation field re-extracted slightly differently would stop being a retry.
  - **Why not:** the catalog had already decided it. `idempotency_records`,
    `integration_calls`, `notification_dispatches` and `backfill_ledger` all key on **scope plus
    key**, and not one includes request content. `signal_name` is scope; `correlation_key` is content.
    A constant key across instances is not an idempotency key, and the right repair is an
    `idempotencyVariable` read from an instance variable, mirroring `correlationVariable`.

- **Option B: `decimal` as a JS number everywhere.**
  - **Pros:** matches the manifest's declared type and the JSONB store's existing behaviour; no
    consumer changes.
  - **Cons:** **51 of the 92 `decimal` fields in the shipped packs declare `precision >= 16`** (47 at
    `(16, s)`, four at `NUMERIC(20,10)` FX rates), and binary64 round-trips a decimal losslessly only
    to 15 significant digits (`DBL_DIG`). So it silently truncates most of the catalog's declared
    range. Made loud, it throws on *reading* a legitimately stored value, which is worse.
  - **Why not:** silent precision loss in a double-entry ledger.

- **Option C: a precision-dependent wire type** — number when the declared scale and precision fit a
  double exactly, string otherwise.
  - **Pros:** each field gets the cheapest honest representation.
  - **Cons:** makes two fields both named `amount` **different types** depending on a `precision` no
    client can see in the payload. No generated SDK can type the field; no consumer can write one code
    path. And it buys nothing, because `0.1 + 0.2 !== 0.3` at any precision — summing scale-2 amounts
    in doubles still drifts.
  - **Why not:** if a double is the wrong container for the hard half of the catalog, it is the wrong
    container for the easy half too. (This is the option the orchestrator initially inferred from the
    lane's exported names and had to be corrected on: `MAX_EXACT_DOUBLE_DIGITS` and
    `decimalSpecFitsDouble` are the *evidence rejecting* precision-dependence, with no caller in the
    wire path, not the switch implementing it.)

- **Option D: a tagged decimal value, `{"$dec":"10.25"}`.**
  - **Pros:** lossless and self-describing.
  - **Cons:** breaks every client, every `?amount=10.25` filter, and JSONB ordering.
  - **Why not:** a wire format nobody can consume without a library.

- **Option E: refuse `precision > 15` in the manifest**, making "number" honest.
  - **Pros:** the simplest consistent story.
  - **Cons:** requires re-declaring 51 fields across seven packs, and still leaves double arithmetic
    in a general ledger.
  - **Why not:** it fixes the type by forbidding the requirement.

- **Option F: a bounded `soft_bounce_exceeded` for the fax run** rather than a permanent
  `hard_bounce`.
  - **Pros:** reads perfectly — a threshold was crossed — and limits the damage of being wrong.
  - **Cons:** `PostgresSuppressionStore`'s only conflict action is `DO NOTHING` (ADR-0302: a replayed
    signed body must not extend a suppression) and `suppressionIdFor` commits to
    `(tenant, channel, address, reason)`. So a bounded row **cannot be renewed**: the window lapses,
    the lapsed row keeps the id, and the next crossing inserts nothing.
  - **Why not:** "bounded" would mean *suppressed for thirty days and then never suppressible again* —
    the full risk of being wrong with none of the benefit. Of the two honest options, permanent is the
    one that does what it says, and being wrong is now visible in the observation row.

- **Option G: reset the fax run on `busy` or `no-answer`.**
  - **Pros:** cuts false positives for a human who misses calls, which is the population the feature
    could hurt.
  - **Cons:** `busy` is **consistent with** a fax machine — one mid-transmission returns busy — so
    resetting on the pair is wrong on one of its two members. Splitting them means asserting a
    fax-machine behaviour model ("a powered fax always answers") that nothing here can verify and that
    a powered-off fax breaks anyway.
  - **Why not:** the line the parser already draws is defensible without inventing one — *only an
    answered call says anything about what is on the line* — and the false-positive worry is answered
    by the window, the threshold and the opt-in.

- **Option H: choose a wire form for `INTERVAL` now.**
  - **Pros:** closes the third instance of the node-postgres type class completely.
  - **Cons:** zero `duration` fields are declared in any pack, app or trait, so the contract would be
    designed against no requirement — and it needs an answer for ordering in the in-memory store too.
  - **Why not:** inventing a contract for a field nobody has declared is how a wrong one gets locked
    in. The **silent** half is closed instead: `readColumn` throws `UndecidedWireTypeError` on an
    `INTERVAL` column, so the first `duration` anybody declares fails at the first read naming itself,
    rather than six months later with `[object Object]` in somebody's cursor.

## Consequences

- **Positive.** A tenant session can no longer write, change or remove a platform-wide row on any of
  the 29 tables, and the write is reachable only by a session that sets the right one of four
  transaction-local GUCs — verified live as a non-owner role across a **44-case forgery matrix**, all
  44 unambiguous, plus 13 cases driven through the real stores including a raw tenant-session forgery
  refused. The `_platform_read` arm is preserved on every one of them, so no existing reader lost
  access. A signal fan-out stores one row per delivery and the replayer stops reporting drift on
  healthy data. Dedup survives a restart and reaches a second replica. Two implementations of one
  `EntityStore` agree about what a `decimal` is, and two real mis-postings in the ledger are fixed.
  `PostgresFeatureFlagStore` can round-trip a flag at all — `FEATURE_FLAG_COLUMN_NAMES` said
  `default_value` where ADR-0308's rename machinery had moved the column to `default_value_json`, so
  every write failed against a real database while every offline test passed, and the list is now
  asserted against `META_TABLES` rather than maintained beside it.
  Four files are searchable, so a "find all callers" sweep no longer has blind spots it does not
  report. A number that is a fax machine can stop consuming voice notifications. A stall episode says
  which kind it currently is. Platform-scope rows are verified by default.
- **Negative.** Arithmetic is still **double** arithmetic: the wire type is exact, `num()` and the
  reports' `readonly total: number` are not, so summing scale-2 amounts in a ledger still drifts — the
  fix is a decimal library through the effects, which is its own increment. The JSONB store still sorts
  a decimal **lexicographically** (`document ->> 'f'` is TEXT whichever way the JSON held it), which is
  a distinct pre-existing ordering defect this increment did not touch; closing it needs a guarded
  cast, because `'n/a'::numeric` **raises** and would take down a whole query rather than one row. An
  unparseable stored decimal now makes its record and any page containing it unreadable, which is
  sharper than before and taken deliberately — a wire type a consumer can only usually rely on is not
  one. A fax suppression can be imposed once per address and never lifted automatically, and no route
  reads the observation row, so the evidence for a permanent block is only in a log line and the
  suppression's `notes`.
  **Fourteen of the 29 tables have no store at all**, so their new write arms are capability with no
  caller: a GUC nobody sets is no reachable write path, which is strictly tighter than what they had,
  but it is also a grant waiting for a writer that may be wired by someone who never reads this ADR.
  **The grants are not narrowed per tenant or per role** — all four are `PUBLIC`-scoped settings, so
  any session that can call `set_config` can claim one; what the split buys is that claiming it is a
  deliberate act recorded in the transaction rather than the default state of every tenant
  connection. And **reads on these tables remain owner-dependent**: the seven stores that set no
  scope before still set none, so they are correct as the owner (who bypasses RLS) and would see only
  platform rows as a non-owner, which is ADR-0331's `scopeFilter` lesson un-swept outside the chain.
- **Neutral.** `dr_failover_executions` is classified *mutable* in shape against a writer that is
  INSERT-only in practice, so its `UPDATE` arm is unused today; the classification follows the
  contract's state machine rather than the current store, which is the right side to be wrong on — the
  store is the thing that will change. Relatedly, `PostgresDrFailoverStore` silently drops every
  failover completion (`ON CONFLICT (execution_id) DO NOTHING` on what is an upsert path), which this
  increment reports and does not fix. `replace_unique_constraint` was marked `guarded`, claiming a re-check that is not in its
  SQL; by `add_foreign_key`'s own rule it is not guarded, since a failure means the data already
  contradicts the catalog. What makes that failure safe is a different property, and it was measured
  rather than assumed: the `DROP` and `ADD` go out as **one string**, and node-postgres runs a
  multi-statement simple query in one implicit transaction, so a failed `ADD` rolls the `DROP` back.
  Running the same two statements through `psql` *separately* leaves the table with no constraint at
  all — which is why the one-string form is load-bearing rather than stylistic. Also: a fresh database
  holds **145** `meta` base tables against the catalog's 144 (now 145 against 146), the extra being
  `_meta_migrations`, which the applier creates for its own bookkeeping and deliberately does not
  emit. That is not drift, and it is now written down.
- **Reversibility.** The wire-type change is the hard one to undo: it is a public contract and clients
  will have been written against it. The signal constraint is a widening and reverts only while no
  fan-out row exists. The rest — the NUL escapes, the fax counter, the stall note, the two defaults —
  are each independently revertible.

## Implementation notes

- The policy split is enforced by the catalog's own test suite rather than by a maintained list.
  `meta-schema.test.ts` asserts, over every table: a platform **read** arm is `SELECT`-scoped and its
  `using` is exactly `tenant_id IS NULL`; each read arm has exactly **one** matching `INSERT` arm; a
  write grant is always ANDed with `tenant_id IS NULL` and never appears on a `SELECT` policy; and the
  string `IS NULL OR` appears in no policy predicate anywhere. The four grant names are spelled
  **locally** in that test rather than imported, because importing them would invert the package
  dependency. `kernel-pg`'s canonical test replaced its hand-kept `NARROWED_POLICIES` set with the
  rule `/_platform_(audit_)?(read|write|update)$/` and one count — **78**, being ADR-0313's and
  ADR-0331's 8 plus the split's 70 — so a 30th table cannot be added without the number moving. A
  hand-maintained list is precisely what ADR-0288's `needsAuditEmitter` was, and it was wrong three
  times.
- `meta.workflow_signals`' constraint change is a **widening**, so it applies on a populated table:
  appending a column to a unique key cannot fail against existing rows. Verified live on both an empty
  and a populated table, and the *narrowing* direction verified to fail and roll back.
- The canonical decimal form is not invented — it is Postgres's own rendering, and a 25-case rounding
  parity table against PostgreSQL 16.13 is pinned as a test so the renderer cannot drift from the
  database it must agree with. Both overflow cases match Postgres raising `numeric field overflow`.
- `optionalNum()` replaces the three `typeof x === "number"` presence tests and distinguishes absent
  from zero, which `num()` structurally cannot.
- The fax counter performs its rule in **one** `ON CONFLICT … DO UPDATE`, following
  `PostgresReadStateStore`'s precedent: a read-modify-write loses its race in the direction that
  *advances* a run, which is the direction that writes a permanent block. `CallSid` is required,
  because Twilio retries a non-2xx callback and a counter has none of the natural idempotency a
  suppression id has — one call's retries would otherwise have walked a number to the threshold alone.
  The route answers **200** for a recorded observation, which removes the retry at source.
- `AnsweredBy` arrives only when `TWILIO_VOICE_MACHINE_DETECTION` is set, so the counter warns at boot
  when it is not — a threshold configured and structurally unreachable is exactly the silence this
  increment is about.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Should reusing one idempotency key under a different correlation key be a named 409 refusal? It currently returns the first key's deliveries, which is a worse lie than the empty list it replaced. | Platform | 2026-11-30 |
| Should the JSONB store cast a `decimal` for ordering, and how is `'n/a'::numeric` guarded so one bad row does not fail a whole query? | Platform | 2026-12-15 |
| Does the accounting core move to a decimal library, now that the wire type is exact and the arithmetic is not? | Platform | 2027-01-31 |
| Should `SignalDefinition.idempotencyKey` be renamed `idempotencyKeyVariable` and actually read, given the rename needs a content-digest version bump? | Platform | 2026-12-31 |
| Should the four write grants be narrowed from `PUBLIC` to a named role, so claiming one is an authorisation rather than a `set_config` call any session can make? | Platform | 2027-01-31 |
| `certification_reports` is the loudest member of the `record` group — a forged platform certification report is a compliance claim, not telemetry. Does it want its own grant, separate from the other 16? | Platform | 2026-12-31 |
| `meta.audit_integrity_verdicts` has a differently-shaped hole: its `ALL` policy ORs in the `app.platform_audit` **read** grant, so an elevated *reader* can forge a verdict. Splitting it means narrowing an isolation policy from `ALL` to `SELECT`, which is a larger edit than adding arms beside one. | Platform | 2026-11-30 |
| Do the seven stores that set no tenant scope before a read on these tables get `scopeFilter` predicates, per ADR-0331's chain finding? They are correct only as the table owner. | Platform | 2026-12-31 |
| `PostgresTimerStore` omits `kind` and `PostgresActivityStore` omits six NOT NULL no-default columns, so neither can write against a real database — ADR-0331's signal-store class on two siblings. Where does each omitted value legitimately come from? `retry_policy` and `timeout_seconds` are properties of the activity's *definition*, which the projection does not carry. | Platform | 2026-11-30 |
| `PostgresDrFailoverStore` and `PostgresDrDrillStore` use `ON CONFLICT … DO NOTHING` on an upsert path, so a failover's completion is silently dropped and the row keeps its declared status forever. | Platform | 2026-11-30 |

## References

- ADR-0331 — the increment that measured the node-postgres types and left the `decimal` wire type undecided; its addendum records `crossengin.tombstone.content.v3`.
- ADR-0313 — the `ALL`-scope `USING`-as-`WITH CHECK` reasoning, and the first table split.
- ADR-0290 — dropping a policy is a loosening the reconciler refuses, which is why a renamed policy
  would have needed 29 hand-run drops; ADR-0331 measured that trap on two tables.
- ADR-0288 — a hand-maintained list of the things a feature touches, wrong three times; the reason the
  split is asserted by a rule and a count rather than by a set.
- ADR-0302 — a safety record must never widen on an inference; `DO NOTHING` on a suppression.
- ADR-0289 — a row the contract forbids and a CHECK permits.
- ADR-0287 — truncation detection needs a checkpoint witness, which is why `includePlatform` is one decision across two configs.
- IEEE 754 binary64 and `DBL_DIG` (15 significant decimal digits); PostgreSQL `numeric` rendering and `ALTER TABLE … ADD CONSTRAINT … UNIQUE` validation.
