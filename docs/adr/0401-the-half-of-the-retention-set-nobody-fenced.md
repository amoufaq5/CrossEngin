# ADR-0401: The half of the retention set nobody fenced

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-04 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0400, ADR-0330, ADR-0332, ADR-0335, ADR-0351, ADR-0374, ADR-0375, ADR-0399 |

## Context

ADR-0400 fenced sixteen `meta` tables against a tenant-context `DELETE` and CLAUDE.md recorded the
rule as a biconditional: *"a restrictive policy exists iff the Article 17 erasure retains the
table."* This increment is the result of aiming a refuter at that commit — register P3.1's own
*"aim a refuter at the corrections"* clause applied to the increment that cited P3.1 four times.
Thirteen measurement reports were audited against the pushed tree and every claimed refutation was
adversarially verified; 85 claims, **76 survived**, 8 were refuted and 1 needs a live cluster.

The headline is one sentence: **the biconditional was false, and false in the direction that the
rule enforcing it would have refused the fix.**

The erasure retains **18** tables, not 16. `RETAINED_SHARED_TABLES` is the erasure's own derived
union — `[...PLATFORM_RECORD_TABLES, ...STATUTORY_RETENTION_TABLES.map((r) => r.table)].sort()` —
and `retained − fenced` was exactly `["invoices", "tenant_credits"]`. Both carried only
`*_tenant_isolation`: `ALL`-scope, permissive, NULL `WITH CHECK`, which is the identical shape the
sixteen had before ADR-0400 and which makes the arm's `USING` serve as the check for every command.
So a tenant-context `DELETE` reached them, measured live against the owner's own count as the
control.

The two halves are retained for **opposite** reasons, which is why one increment covered one and
not the other. `PLATFORM_RECORD_TABLES` is the platform's record of what happened to a tenant: not
the tenant's data, not an Article 17 subject, silent in the proof. `STATUTORY_RETENTION_TABLES` is
the inverse on every axis — those rows *are* the data subject's, Article 17 *does* reach them,
Article 17(3)(b) is why they stay, and the proof **names** them with the obligation that keeps them
(ADR-0330). ADR-0400's argument was written for the first half (*"an auditor or a regulator reads
these after the tenant is gone"*) and its predicate was that half's constant, so the second was
outside both the reasoning and the fence.

And the exposure on the second half is worse than a missing record, which the repository's own prose
already said. `meta.tenant_credits`' retention comment reads: *"a credit note is itself a tax
document, adjusting output tax — so retaining the invoices and destroying these would leave a
**retained** record that overstates the tax charged, which is a worse outcome than keeping
neither."* Deleting `tenant_credits` alone is precisely that state. Nothing refused it, nothing
warned, and **no verdict could see it**: the tombstone's digests commit to the scope that *was*
composed, the scope was correct, and `statutoryRetained` still named the obligation — so the proof
asserted a lawful retention over rows a tenant had removed.

## Decision

**The fence's predicate is the erasure's retention union, and the rule asserts the biconditional
CLAUDE.md claims.** Three parts.

1. `retainedRecordNoTenantDelete("invoices")` and `…("tenant_credits")` join the sixteen. 18
   restrictive policies, set-equal to `RETAINED_SHARED_TABLES`, so meta-schema invariant 5 is now
   **true as written** rather than needing to be weakened to match a narrower checked property.

2. `pg-record-retention.ts`'s fence arms compare against the **union** read from disk, via a new
   `readStatutoryRetentionTables()` and `readRetainedTables()`. The arms that are genuinely about
   `PLATFORM_RECORD_TABLES` — the original cascade check — keep that narrower predicate, because a
   tenant's own retained data cascading away with its tenant is a different question nobody has
   decided.

3. A fourth arm, `fenced_table_cascade_parent_unfenced`: RLS is not applied to referential actions,
   so an `ON DELETE CASCADE` from an unfenced parent deletes a fenced child's rows with the child's
   policy in place and never consulted. Measured, all **3** CASCADE edges into a fenced child have a
   fenced parent (`access_review_items → campaigns`, `decisions → items`, `exceptions → items`), so
   the set is closed today and the fence is complete as shipped — but nothing asserted the closure,
   and no other arm of the rule can see it.

**The restrictive arm, and deliberately not a move into `PLATFORM_RECORD_TABLES`.** That move is
what ADR-0400's open question 2 prescribes for the unfenced residue (*"the right output is probably
additions to `PLATFORM_RECORD_TABLES` rather than a second list"*), and here it would **produce the
defect**: `partitionSharedTables` would stop classifying these two as statutory, `statutoryRetained`
would empty, `sharedTableRetention` would answer `null`, and the attestation would degrade from
`erased_and_retained` to `erased` — a signed tombstone claiming it destroyed the one table the law
required it to keep. ADR-0337's falsely-true direction, created by the remedy. The fence leaves the
partition untouched, verified: `retained 18 / platformRecord 16 / statutory 2` with both obligations
intact.

## Alternatives considered

- **Option A: weaken invariant 5 to describe what the rule checked.** Say "a restrictive policy
  exists iff the table is in `PLATFORM_RECORD_TABLES`" and record the two statutory tables as an
  open end.
  - **Pros:** no code change; the register becomes accurate in one edit.
  - **Cons:** leaves a measured exposure open, on the pair whose joint destruction the retention
    set itself calls worse than keeping neither.
  - **Why not:** it corrects the *claim* to match the weaker property when the claim was the right
    one. The fence costs one line per table and nothing else — measured 0 unreconciled steps — so
    there is no trade to make.

- **Option B: move the two into `PLATFORM_RECORD_TABLES`.** The remedy ADR-0400's own open question
  prescribes.
  - **Pros:** one constant, no predicate change, invariant 5 true without touching the rule.
  - **Cons:** destroys the Article 17 claim, per the Decision above.
  - **Why not:** refuted on measurement. It is the register's prescribed remedy for this class and
    it is wrong for these two tables, which is register P3.1's clause — *a remedy is a claim too,
    and it is the one an increment spends itself on.*

- **Option C: narrow the two `ALL` arms to three commands instead of adding a restrictive arm.**
  - **Pros:** the catalog then has no restrictive policy on these tables at all.
  - **Cons:** three policies per table against one, a `replace_policy` that drops and recreates a
    live isolation arm, and — the part that is not mechanical — **the `ALL` arm's `USING` doubles as
    the `INSERT` `WITH CHECK`**, so the replacement `INSERT` arm must restate the predicate in
    `WITH CHECK` or the table stops accepting tenant writes.
  - **Why not:** ADR-0400 measured this and chose the restrictive form; nothing here changes that,
    and the third clause makes the narrowing strictly more than a command split.

- **Option D: a `BEFORE DELETE … FOR EACH STATEMENT` trigger, so the refusal is loud.** Raised by
  the audit as a fourth mechanism ADR-0400 did not weigh.
  - **Pros:** converts the silent `DELETE 0` into a named error, and fires for `DELETE … WHERE
    false` where a row-level policy does not.
  - **Cons:** a second, parallel enforcement mechanism outside `TableRls`, inexpressible in the
    catalog, invisible to the reconciler, and it answers a different question — the policy bounds
    *who*, a trigger bounds *whether anyone*.
  - **Why not:** kept as an open end rather than refused outright. It addresses the harm open
    question 3 names and does not address what the fence is for, so it is a candidate for the
    silent-zero problem and not a replacement.

- **Option E: `FORCE ROW LEVEL SECURITY` on the four forensic tables.** ADR-0400's refused variant,
  re-examined because its refutation contained an error (below).
  - **Why not:** unchanged. FORCE does not close the defect — the exposure is a tenant-context
    session and FORCE only makes the owner into one — and it is inexpressible in `TableRls`. What
    changes is the *stated mechanism*; see Implementation notes.

## Consequences

- **Positive:** the two statutory tables are closed; invariant 5 is true rather than aspirational;
  the rule now enforces the claim it is cited for; the fence's CASCADE closure is asserted instead
  of accidental; and `emitRlsPolicy` refuses a clause the declared command cannot carry, which it
  had documented and not guarded.
- **Negative:** two more silent `DELETE 0` sites. Neither has a tenant-context `DELETE` writer —
  `meta.tenant_credits` has **zero** statements of any kind in the workspace and `meta.invoices`
  has insert-only — so no route breaks, but a future writer would meet a refusal that raises
  nothing.
- **Neutral:** the emit grows 981 → **983** statements, 213 → **215** `CREATE POLICY`, 16 → **18**
  `AS RESTRICTIVE`, and `AS PERMISSIVE` stays **0**. `kernel-pg`'s narrowed-name census moves
  98 → **100**.
- **Reversibility:** two catalog lines and a predicate. The policies are additive, so reverting is a
  `DROP POLICY` pair that `planSchemaReconciliation` will not plan for you — the same one-way cost
  ADR-0400 took, and the reason it chose the additive form.

## Implementation notes

**Live verification**, as the non-owner `serving` role on PG 16, with the owner's own count as the
control and a hard non-vacuity floor that aborts rather than printing zeros:

| table | owner | tenant DELETE before | after |
|---|---|---|---|
| `meta.invoices` | 1 | **1** | **0** |
| `meta.tenant_credits` | 1 | **1** | **0** |
| `meta.audit_log` (ADR-0400's fence, untouched) | 1 | 0 | 0 |
| `meta.operate_tenant_settings` (unfenced control) | 1 | **1** | **1** |

`UPDATE` and `SELECT` on a fenced table answer 1 throughout, so the fence is per-command;
cross-tenant is 0 throughout; the empty-scope control answers 0, which is the stated silent-zero
cost; `row_security_active` is `t` for `serving` and `f` for the owner. The two arms were dropped
and restored in one run, and the restore was re-measured — ADR-0400's measurement defect #2 was a
"before" that was an "after" because a destructive probe left its state behind.

**My own measurement defects, both of them ADR-0400's own, reproduced.** The first draft of the
verification printed a flawless all-zero AFTER *and an identical all-zero BEFORE*, because the
`tenants` insert had failed and every table was empty — defect #1, a vacuous run whose zeros read as
clean, and the tell was that BEFORE equalled AFTER. The seed is generated from the built catalog now
rather than hand-written, and `require_rows` aborts. Then the generator omitted `tenant_id` from
`meta.audit_log` because that column is **nullable** there (NULL means platform scope), so the row
would have landed at the wrong scope — defect #4 exactly. It forces `tenant_id` in whether or not
the column is NOT NULL. A third, smaller one: `CHAR(3)` is how the catalog spells
`meta.invoices.currency`, and a `^CHARACTER` prefix test misses it, so the value fell through to a
5-character default and `22001` aborted the seed. Each was caught by the floor, not by reading.

**The CASCADE closure is derived, not measured.** The 3-of-3 figure comes from the built catalog;
that a cascade crosses a restrictive policy is documented PostgreSQL referential-integrity
behaviour, and the live arm for it did not run (its fixture seed failed a `NOT NULL` the generator
does not satisfy). Stated rather than claimed.

**`readInlineCascadeEdges` is bounded to the inline form on a measurement.** Of 116 CASCADE edges in
the built catalog only 16 are inline; 99 come from the shared `TENANT_FK` constant and 3 from
`USER_OWNED_FK`. Those point at `meta.tenants` and `meta.users`, neither retained nor fenced, so no
shared-constant edge can reach a fenced child — and `cascadeConstantTargetsAreUnfenced` asserts that
premise rather than trusting it, because "the inline form is enough" is exactly the convenient bound
that stops being true unnoticed.

**A parse that answered plausibly rather than refusing.** `readStatutoryRetentionTables`' first draft
searched for `"\n);"`, which is `PLATFORM_RECORD_TABLES`' shape; this set is written
`Object.freeze([ … ])`, so the search ran past the end of the literal and stopped at a later
declaration's terminator. It passed against the real file by over-reading and failed only on a
fixture. It bracket-matches now.

### Corrections to what ADR-0400 shipped

Each was verified independently before being written here.

- **`rolsuper` versus `rolbypassrls`.** ADR-0400 states *"it is `rolsuper` and not `rolbypassrls`
  that defeats FORCE … so no role attribute short of dropping `SUPERUSER` rescues it"*. **Both
  attributes defeat FORCE independently**, and the operative half is the conclusion: the shipped
  `crossengin` role carries *both*, so dropping `SUPERUSER` leaves `BYPASSRLS` and FORCE is still
  defeated. The repository's own truth table is the exact form — a session is confined iff
  `relrowsecurity && !(rolsuper || rolbypassrls) && (relforcerowsecurity || !owner)` — and
  `kernel-pg` already carried a test titled *"does not refuse a rolbypassrls role on a forced
  table"*. This is a false **remedy** in `## Alternatives considered`, the one place a reader looks
  to find out why an option was not taken, and it is the **second** such error in that paragraph:
  it opens by correcting a wrong refutation and the replacement it offers as "stronger" carries this
  one. P3.1's correction-of-a-correction clause, paying out twice in one paragraph.
- **`relforcerowsecurity` "appears in no source file".** It appears in **3 non-test source files**
  (14 occurrences over 6 files) and is **selected in live SQL** —
  `c.relforcerowsecurity AS rls_forced` inside `SESSION_POLICY_VISIBILITY_COLUMNS` — parsed, and
  turned into a named verdict reason. "Nothing emits, diffs or plans it" holds; "appears in no
  source file" and "nothing introspects it" do not. The honest narrower claim is that it is read
  into the *session-confinement probe* and never into the schema snapshot, so the diff structurally
  cannot see it. A zero-occurrence census that is wrong, committed inside the increment citing
  P3.1's `requiresHttpsTransport` member — which is the same shape.
- **A wrongly-fenced route answers 404, not success.** ADR-0400 calls it *"a route that reports
  success and does nothing"* and attributes it to `meta.operate_entity_records`. Traced: that
  statement ends `return res.rowCount > 0`, so a fenced `DELETE 0` makes `remove` answer `false` and
  the handler's delete arm returns `json(404, …)` — a visible **404 for a record that exists**.
  Still a wrong answer and worse than a no-op, but the silence is one layer down, not at the caller.
- **109 / 99 / 93.** Claim 13's "109 of the 115 have no tenant-context `DELETE` writer and are
  deliberately NOT fenced" is rendered post-decision in three places as if 109 were the *unfenced*
  set. The 109 is the writerless set and **includes** the fenced tables; the unfenced-and-writerless
  residue was 93 and is now **91**. CLAUDE.md's own open-ends item had it right, so the shipped
  commit contradicted itself.
- **Invariant 3's provenance.** It says the narrowed-name count "was **78** over the narrower regex
  until ADR-0400". It was **82** — the regex and the figure are both in `canonical.test.ts`, whose
  own comment says *"82 since ADR-0335"*, and `git show 4e66c0e` confirms it. 78 is the
  `%_tenant_isolation` family count, borrowed from a different census ~4,400 lines away and stated
  correctly there. A reader doing the arithmetic gets 94 and hunts four phantom policies.
- **Two surviving pre-fence assertions.** CLAUDE.md's ADR-0374 narrative still read *"78 `meta`
  tables are in that state, 0 of them carry a `DELETE`-scoped policy"* and *"Narrowing 78 isolation
  arms … is reported rather than taken"* — stale on the figure (115 structurally), on the fact (16
  carried one), and on the disposition (the decision was taken). The correction reached four other
  sites and missed these two.
- **"`DELETE` is reachable by no policy on any of them"**, in the paragraph about the 29 write-split
  tables, is now false for **7** of them: the write-split set is 33 and its intersection with the
  fenced set is exactly `access_review_templates`, `audit_integrity_verdicts`, `audit_log`,
  `certification_reports`, `crypto_keys`, `forensic_chain_checkpoints`, `forensic_chain_entries`.
- **The forensic trail is four tables, not three.** The ADR-0374 narrative enumerates
  `forensic_chain_checkpoints`, `forensic_chain_entries` and `audit_log`;
  `meta.audit_integrity_verdicts` is the fourth and was measured at the same owner-count parity.
- **The "drifted" classification stands; its stated mechanism does not.** CLAUDE.md says ADR-0332's
  four census figures "drifted because tables were added, not because anything was wrong when
  written". A refuter called them wrong-when-written and **that refutation was itself refuted** —
  all four were correct at their commit. But the mechanism is wrong for three of the four: they did
  not move because tables were added, and `UPDATE 12 → 13` is a *reclassification* of
  `dr_drill_executions` rather than growth.
- **Three comments asserting the inference ADR-0400 corrected.** That increment fixed
  `DELETE`-is-denied-by-absence in `meta-schema.test.ts` and left it in the catalog six lines above
  its own new fence (`meta.audit_integrity_verdicts`), plus two "reachable by no policy at all"
  copies in test prose. The catalog's companion count, "the other 31", was **wrong when written**:
  the comparison class has been 33 at every commit the comment has existed in, so "the other" was 32
  from the first keystroke. All four are corrected, and the catalog comment now carries neither a
  count nor the inference.
- **`pg-column-coverage.ts`' scan-gap prose.** It described `entity-ops.ts`' `table` argument as *"a
  tenant's own entity table"*; its sole caller sets
  ``this.table = `${schema}.operate_entity_records` ``, a **catalogued** table — and that is ADR-0400's
  own named example of a table that must not be fenced, so the sentence most likely to mislead a
  reader pointed at exactly the wrong conclusion. Worse, the `PG_SCAN_GAPS` doc comment generalised
  it into a universal negative (*"None of these is a catalogued table"*) and then stated a
  load-bearing invariant (*"every `INSERT` in the workspace whose target is a catalogued table is
  read and checked"*) that two files falsify. Three copies corrected; the per-entry reasons were
  right all along and `job-cancellation.ts`' own reason contradicted the summary in the same
  constant.
- **`emitRlsPolicy` guarded nothing it documented.** Its comment said
  *"`CREATE POLICY … FOR INSERT USING (…)` is refused by Postgres"* and no guard enforced it, while
  `emit.test.ts` looped over all five commands with `using` set and **pinned
  `FOR INSERT USING (true)` as the correct emission** — 34 lines above the sibling test whose
  comment explains why it cannot run. This file's fifth documented-the-hazard-and-checked-nothing
  member. `POLICY_CLAUSES_BY_COMMAND` is the total map and the loop test is a partition driven by
  it. Zero members in the catalog before or after, which is when a refusal is cheapest; the
  reachable population is a *new* declaration, and the catalog has paired a non-default command with
  a clause 82 times across ADR-0313 and ADR-0332 without error, so ADR-0400's DELETE arm is the
  fourth command declared rather than the first.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `meta.operate_tenant_manifests` is the **only** table of 115 whose platform grant is ORed inside an `ALL`-scope policy's `USING`, with a NULL `WITH CHECK` — so `app.platform_review` buys cross-tenant read **and UPDATE, DELETE and INSERT**. Verbatim the defect ADR-0313 split out of `meta.audit_log`; ADR-0332's sweep missed it because its universe was tables gaining a *write* GUC. Cannot simply be narrowed to `SELECT`: `design-review-store.ts`' `decide()` claims the grant for a cross-tenant `UPDATE` by design, and the shipped compose passes `--require-design-review`. | Platform | 2027-01-31 |
| The remaining **91** unfenced-and-writerless exposed tables (115 exposed − 18 fenced − 6 with a `DELETE` writer). Of those 91, **26** already carry a non-`ALL` platform arm — the signal that the platform itself writes them, i.e. that they may hold evidence about a tenant — and **65** carry nothing but the isolation arm. That census is the triage handle ADR-0400 open question 2 asked for and did not supply. Re-derive it rather than quoting it: an audit slice reported this split as 90 / 64 and that was a *pre-fence* decomposition which also subtracted `meta.operate_design_jobs` twice — it has a `DELETE` writer, so it is already outside the 109. | Platform | 2027-03-31 |
| `TRUNCATE` is outside **every** policy mechanism and no policy can close it — RLS does not govern referential actions or `TRUNCATE`. Not live (no role is granted it) but an unstated carve-out in the fence's guarantee: it is a `GRANT` question, not a policy question. | Platform | 2027-03-31 |
| `UPDATE` stays open on all 115. ADR-0400's open question 1 asked this with two wrong figures; measured, **two** of the sixteen carry a declared platform `UPDATE` arm and **five** have an `UPDATE` writer, intersecting in `crypto_keys` alone. A restrictive `FOR UPDATE` carries both `USING` **and** `WITH CHECK`, so it is not this increment's shape — and the loud form is `USING (true) WITH CHECK (false)`, which raises where `USING (false)` is silent. | Platform | 2027-03-31 |
| `deploy/` provisions **no least-privilege database role at all** — zero `CREATE ROLE` and zero `GRANT` across every `.sql`, `.yml` and `.md` in it — so the fence is live on no configuration the product ships a path to. ADR-0400 states the consequence and not the cause. | Platform | 2027-03-31 |
| A statement-level `BEFORE DELETE` trigger (Option D) is the only mechanism weighed here that fires on the deployment that ships, and it converts the silent zero into a named refusal. Whether that earns a second enforcement mechanism outside `TableRls` is undecided. | Platform | 2027-06-30 |
| `FORCE ROW LEVEL SECURITY` is invisible to the reconciler — it is read only into the session-confinement probe, never into the schema snapshot — so an operator who hand-applies it gets no drift report ever. | Platform | 2027-06-30 |

## References

- ADR-0400 — the sixteen-table fence this corrects and extends.
- ADR-0330 — `STATUTORY_RETENTION_TABLES` and the `erased_and_retained` outcome.
- ADR-0332 — the write-split sweep whose universe excluded read-grant tables.
- ADR-0313 — the rule that an `ALL`-scope policy's `USING` doubles as its `WITH CHECK`.
- ADR-0351, ADR-0362, ADR-0372, ADR-0395, ADR-0398 — the documented-the-hazard-and-checked-nothing
  class `emitRlsPolicy` joins.
- PostgreSQL 16, `CREATE POLICY`: per-command clause compatibility, and RLS not applying to
  referential actions or `TRUNCATE`.
