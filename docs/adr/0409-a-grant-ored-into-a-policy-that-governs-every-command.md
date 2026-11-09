# ADR-0409: A grant ORed into a policy that governs every command

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-09 |
| **Authors** | CrossEngin platform team |
| **Reviewers** | CrossEngin platform team |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0313, ADR-0314, ADR-0321, ADR-0331, ADR-0332, ADR-0333, ADR-0334, ADR-0337, ADR-0348, ADR-0355, ADR-0370, ADR-0372, ADR-0389, ADR-0400, ADR-0401 |

## Context

`CREATE POLICY` defaults to `FOR ALL`, and an `ALL`-scope policy whose `WITH CHECK` is NULL has its
`USING` expression serve as the check for every command. So ORing a cross-tenant grant into such a
policy's `USING` does not buy a cross-tenant **read**; it buys read, `INSERT`, `UPDATE` and `DELETE`
across every tenant, plus the ability to move a row from one tenant to another.

`meta.operate_tenant_manifests` carried exactly that. Measured from the built catalog: of **215**
policies across the **115** RLS-enabled `meta` tables, **exactly one** has an `OR` in its `USING` —
this one — and there are only **two distinct `ALL`-scope `USING` expressions** in the whole catalog,
114 byte-identical pure tenant isolation and that one. So it was not merely the only `OR`; it was the
**only `ALL`-scope policy whose `USING` is satisfiable without a tenant match**. All 115 `ALL`-scope
policies carry an absent check (0 of 215 emitted `ALL` statements contain `WITH CHECK`), so the
`app.platform_review` grant reached every command on every tenant's row.

**This repository had already identified the shape, fixed it on the sibling, and declared the class
empty.** `packages/kernel-pg/src/canonical.test.ts`'s census comment reads, of
`meta.audit_integrity_verdicts`:

> plus 2 for `meta.audit_integrity_verdicts` — **the last member of that class**, whose single `ALL`
> policy ORed in the cross-tenant *read* grant and so let an elevated reader forge, flip or delete a
> verdict at any scope.

And `meta-schema.test.ts` states the mechanism outright: *"The isolation arm must not carry the read
grant: on an `ALL`-scope policy the `USING` expression also serves as the `WITH CHECK` … Twelve such
forgeries succeeded live as a non-owner role before the split and none after."* That is this defect
word for word. The declaration was false because ADR-0332's 29-table sweep matched the
`tenant_id IS NULL OR` spelling, and here the `OR` joined a **GUC** instead — outside that sweep's
universe. Meta-schema invariant 3 is blind to it by construction too: as implemented it is a
name↔command biconditional that never reads `USING` at all, and the `IS NULL OR` check it does make
is a strict equality against one full predicate string.

A second test pinned the defect as the specification. `meta-schema.test.ts`'s
*"META_OPERATE_TENANT_MANIFESTS allows an explicit platform-review escape from tenant isolation"*
asserted that the one `ALL`-scope policy's `USING` **contains** the review GUC, and that some emitted
statement carries both the policy name and the GUC — under a comment calling the elevation *"the
cross-tenant **read**"*. ADR-0372's class, and the reason the defect survived three increments past
the sibling's fix.

Measuring the table also found a second defect in neither the register nor this file.
`PostgresActivationWatermarkSource.activationWatermarks()` is the one bare statement against the
table — no tenant context, no elevation — so **neither arm admitted it** and as a non-owner it
matched zero rows with no error code. The poller's first pass recorded that empty map as its
baseline and every later pass compared against it, so cross-replica gateway invalidation was
silently dead for the life of the process (ADR-0333's class). The module's own doc comment cited
`PostgresTenantSource` as the precedent for running unscoped, and the analogy is false:
`meta.tenants` carries no RLS and no policies at all, so that source needs no context and gets none.

## Decision

**Three arms, where there was one.**

1. `operate_tenant_manifests_tenant_or_platform_review` — `ALL`, `USING (TENANT_ISOLATION_USING)`.
   The **name is kept and only the predicate narrows**, which is `audit_integrity_verdicts`'
   committed shape (`_tenant_or_platform_audit`, `ALL`, pure isolation) and not a preference. See
   Alternatives.
2. `operate_tenant_manifests_platform_review_read` — `FOR SELECT USING
   (current_setting('app.platform_review', true) = 'on')`. `SELECT`-scoped, so it carries no
   `WITH CHECK` and cannot authorise a write.
3. `operate_tenant_manifests_platform_activation_read` — `FOR SELECT USING (status = 'active' AND
   current_setting('app.platform_manifest_activation', true) = 'on')`, the poller's own grant.

**`decide` writes under the proposal's own tenant context.** Of the table's six write statements
exactly one was cross-tenant, and it needs no elevation: the tenant is a fact about the row, so
`decide` reads it under the review arm and sets `app.current_tenant_id` on the same transaction
before the `UPDATE`, which is scoped to `(id, tenant_id)` so the statement names its own scope.
`setTenantContextWithin` is the one spelling of *validate, then set*, shared with
`withTenantContext`, because nesting is unavailable — `withTenantContext` opens its own
`conn.transaction` and the real binding's in-transaction connection throws before issuing any SQL.

**The poller gets its own grant and not the reviewer's**, and the reason is the only honest one. A
second GUC does **not** narrow the columns: RLS is row-level, so a `SELECT` arm on any GUC grants
every column of the admitted rows, and column narrowing is unavailable through RLS at all
(`GRANT SELECT (cols)` is role-scoped and both paths are the same serving role, so it would need a
view). What a second grant buys is a narrower **predicate**, and the poller's own
`WHERE status = 'active'` makes it free.

**`NARROWED_NAME`'s optional group is generalised rather than extended by an alternative**: the
segment between `_platform_` and the command word names *which grant* the arm reads, and `audit_` was
its first member. An explicit alternation, so each new qualifier is a deliberate addition.

## Consequences

The escalation is closed and the declared purpose is preserved, measured live as the non-owner
`serving` role on PG 16.15 against the real emitted catalog:

| arm | before | after |
|---|---|---|
| cross-tenant `SELECT` with the grant — the declared purpose | 2 of 2 rows | **2 of 2** |
| same `SELECT` without the grant (control) | 0 | 0 |
| decide: `UPDATE review_status` via the grant | succeeded | **0 rows** |
| decide via the row's own tenant context, same transaction | — | **succeeded**, `RETURNING` intact |
| rewrite the manifest **and** activate it | succeeded | **0 rows**, body unchanged |
| move the row to another tenant, grant alone | succeeded | **0 rows** |
| move it under the row's **own** context | — | **ERROR: violates row-level security policy** |
| forge a proposal for a tenant that never asked | succeeded | **ERROR: violates row-level security policy** |
| `DELETE` the proposal | succeeded | **0 rows** |
| reviewer holding tenant B's context touches A's row | — | **0 rows**; A untouched |
| positive control: the same statement under A's context | — | **1 row** |

Each arm ran in its own process, because a statement in an already-aborted transaction is not a
measurement — two arms raise, and in one shared session everything after them would have proved
nothing. The two positive controls are what make the zeros refusals.

The poller reads its watermarks for the first time (owner 1 / `serving` with no context **0** /
`serving` with the grant **1**), and **both halves of the fix are load-bearing**: the old statement
on the new catalog reads 0, and the new statement on the old catalog reads 0. Its grant is strictly
narrower than the reviewer's, measured: 1 row of any status against 2, **0** drafts against 1, **0**
pending reviews against 1, the draft's `manifest` body unreadable against `["B_SECRET"]`, and 0 rows
affected by an `UPDATE` or a `DELETE`.

**The migration is 3 planned steps, 0 unreconciled, no manual SQL and no `--allow-loosening`** —
measured with the real `planLiveReconciliation` against a *populated* pre-fix database, one
`replace_policy` and two `create_policy`, with a clean re-plan afterwards.

**The window between steps denies the reviewer's reads and no tenant's anything**, which corrects a
note taken while designing. Probed after each step: the reviewer's cross-tenant read goes 2 → **0** →
2 → 2, the poller's 0 → 0 → 0 → **1**, and tenant A's own read and write are **1 / 1 at every step**.
An earlier note said a tenant's own writes were denied for the span of one statement; that was true
of a design where the surviving name's *command* changed and is false of what shipped.

Three things were sharper than the defect.

**Two tests pinned the two defects as the specification**, and both are rewritten rather than deleted
(ADR-0372's class, now the ninth and tenth instances in this run). The catalog test demanded the
`OR`; the poller's was titled *"runs as a platform sweep — **no set_config, no transaction**"* and
asserted the absence of a scope, which is the defect exactly. Each rewrite keeps the property that
was true — the isolation arm is still the default, and the sweep still must not bind one tenant —
and changes only the claim that was false.

**The store's fake could not express the defect.** It modelled the widened policy with a single
`visible()` predicate and routed both `UPDATE` branches through it, so a `SELECT`-only elevation was
*inexpressible*: every approve/reject test passed identically against the widened policy and against
the split. It has a `writable()` predicate now, modelling the isolation arm alone, plus a
non-vacuity floor asserting that the decision write reaches no row under the review grant and one row
under the row's own context. The live run as a non-owner remains the authority for the real policy;
this is only the authority for the fake that stands in for it.

**Three positional parameter assertions broke, and renumbering them would have been the wrong
repair** (ADR-0370's lesson). They indexed `params[1]` and `params[3]` on a statement that gained a
parameter when the tenant was bound. Two now resolve the placeholder through the file's own
`paramIndex(sql, column)` helper, so they assert *which parameter the statement binds for that
column*; the third asserts the whole four-statement sequence, which is the property worth pinning.

The grade stands at the register's P2: being harmed needs a session able to call `set_config`, which
no route provides. What the split changes is that such a session can no longer write. The shipped
compose does pass `--require-design-review` and `--design-review-role`, so the review store is live;
`--manifest-refresh-ms` is absent, so the poller half was latent.

## Alternatives considered

**Narrow the surviving arm's *command* to `SELECT` and add a new `ALL` isolation arm.** This would
have left the surviving name describing its policy *exactly* — it really is "tenant or platform
review", for reads — and it plans identically. **Refused on the naming biconditional**:
`canonical.test.ts` asserts that a policy is scoped to one command **iff its name says so**, and a
name ending `_tenant_or_platform_review` is not in that vocabulary (it names the grant, not the
command), so a `SELECT`-scoped policy with that name trips the else-branch. Admitting it would break
the biconditional for the `_tenant_or_platform_*` family, whose other member
(`audit_integrity_verdicts_tenant_or_platform_audit`) is `ALL`-scope. The stated cost of what shipped
is ADR-0331's: a name that no longer describes its policy, one sibling below a
`_platform_review_read` that does.

**The biconditional is not the fence for what shipped, and reading this section could suggest it
is.** It rejects one *specific* wrong pair — the alternative above, a `SELECT`-scoped arm under a
grant-shaped name — and **admits the opposite wrong pair**: measured, renaming the activation arm to
`operate_tenant_manifests_tenant_or_platform_activation` *and* dropping its `command` passes
`canonical.test.ts` **69 of 69**, because the renamed arm no longer matches `NARROWED_NAME` so the
else-branch requires `ALL`-scope and the mutation supplies it. That pair is exactly the defect this
ADR closes, reintroduced on the new arm. What catches it is the per-table assertion in
`meta-schema.test.ts` (**1 failed of 284** under the same mutation), which pins the names *and* the
`["ALL", "SELECT", "SELECT"]` command list. So the biconditional enforces *internal consistency*
between a name and a command, and only the per-table assertion decides *which* consistent pair is
correct — a distinction worth having before anyone renames one of these arms on the biconditional's
authority.

**Rename the surviving arm to `_tenant_isolation`.** Refused on measurement: a rename leaves the old
permissive `ALL` policy live and undeclared, `allowLoosening` never reaches `policy_removed`, and
because permissive policies are **OR'd** the fix would buy *nothing* until an operator ran a manual
`DROP`. Measured as 1 `create_policy` planned and 1 `policy_removed` unreconciled, permanently.

**Give the write path a platform `UPDATE` arm in ADR-0332's pattern**, which is what the register
prescribed. Refused for three independent reasons. ADR-0389 proved that pattern's check
(`tenant_id IS NULL AND <grant>`) admits no row on a NOT NULL `tenant_id` column, and this column is
NOT NULL. An `UPDATE` arm declared with a `USING` and no `check` would **reproduce this very defect
one arm in**, because Postgres re-uses an `UPDATE` policy's `USING` as its `WITH CHECK` when none is
declared — so a bare-GUC predicate would permit setting `tenant_id` to any value, a cross-tenant row
move by a reviewer. And it is unnecessary: the route holds the proposal's tenant twelve lines before
the write, and the store can learn it in the same transaction.

**Add an `INSERT` arm to pair with the new read arms.** Not owed, and the register's framing that it
was is refuted. `platformReadOf` matches a platform read arm by **predicate equality** against
`tenant_id IS NULL`, so a bare-GUC `SELECT` arm is not recognised as one and the INSERT-pairing rule
skips it — the same escape `gdpr_deletion_requests`, `tenant_lifecycle_events` and
`tenant_tombstones` already take, each carrying exactly `ALL` isolation + bare-GUC `SELECT` +
restrictive `DELETE` with **no INSERT arm** on a NOT NULL `tenant_id`. Adding one would also fire
`auditPlatformWriteArms`, measured: +INSERT alone gives 1 finding, +bare-GUC `SELECT` alone gives 0.

**Share `app.platform_review` with the poller.** The row set it needs is a subset, so this works.
Refused because it would hand a read-only scheduler every tenant's draft proposals and manifest
bodies — measured as 2 rows of any status against 1, 1 draft against 0, and the draft's body
readable. A second grant cannot narrow the columns, but its predicate can narrow the rows.

**Add a `WITH CHECK (status <> 'active')` to a narrowed write arm.** Moot for what shipped (no write
arm was added) and recorded because it reads as free and is not: `REJECTABLE_FROM` is
`["pending", "approved"]` under the comment *"a rejection may also revoke a standing approval"*, so
`decide` can legitimately land on a row whose `status` is `active`.

**Turn the review elevation off inside `decide` before the write.** Necessary for a two-step built on
the *unsplit* policy, because a disjunction permits the write from the review disjunct whatever the
tenant context says. Inert after the split, since a `SELECT`-scoped arm cannot admit an `UPDATE` at
all — so the flag's being on costs nothing and the isolation arm is the only clause that can permit
the statement.

## Open questions

1. **The cross-tenant `DELETE` of a tenant's *own* rows stays open on this table**, as it does on 96
   others (ADR-0400's census). The split closes the *cross-tenant* delete; the isolation arm's NULL
   check still governs `DELETE` for a tenant's own proposals. This table is in neither Article 17
   retention set, so no fence is owed by invariant 5 — adding one would trip
   `fenced_table_not_protected`.
2. **`decide`'s transition guard is still not atomic with its write.** The route reads the proposal,
   checks `APPROVABLE_FROM`/`REJECTABLE_FROM`, then calls the store, which re-reads in its own
   transaction and carries no `review_status` predicate — so two concurrent reviewers both pass the
   guard and the loser's attribution is overwritten, and the 409 the web client already models cannot
   be detected. The in-transaction read now makes the fix cheap (the status is one more column), but
   it needs a discriminated outcome through the store, the route and the fake to tell a 409 from the
   404 a 0-row answer currently produces — and answering 404 for a row that exists is exactly what
   ADR-0342 argues against. Deliberately out of scope; the read selects `tenant_id` alone so the
   store's own pinned layering (*"does not gate on the current review status — the route layer owns
   the transition"*) is unchanged.
3. **A rejection that revokes a standing approval is inert.** `activeManifestFor` filters on
   `status = 'active'` only, so rejecting an already-active manifest moves `review_status` and
   nothing un-serves the manifest. A capability gap rather than a disclosure, and not this
   increment's subject.
4. **`counts()` is the one cross-tenant read with no `WHERE` clause at all**, so it is unfilterable
   by construction and is the statement most clearly unable to be rewritten per tenant. It stays on
   the review arm, correctly — but it means the review grant's reach cannot be narrowed by predicate
   the way the poller's was.
5. **The workspace scanner finds 8 of this table's 14 statements**, and the two it misses appear in
   **no** channel — not `statements`, not `references`, not `unresolved`. Both are `list()` SELECTs,
   discriminated within one file: `FROM ${this.table} WHERE id = $1` is found and
   `FROM ${this.table}${where}` is not. An increment that censused this table from the scanner would
   have missed the review queue's most-used read with no gap reported. That is register P3.3's
   silent-skip member in a channel that entry does not name.
6. **`withPlatformReview` is exported with no importer outside its own test.** Cosmetic since the
   split — an importer could now claim a cross-tenant read and no write — but it is a published
   symbol that claims an elevation, and nothing reports it.
