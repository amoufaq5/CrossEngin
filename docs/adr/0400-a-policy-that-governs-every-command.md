# ADR-0400: A policy that governs every command because nobody chose one

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-03 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0287, ADR-0288, ADR-0298, ADR-0313, ADR-0318, ADR-0322, ADR-0329, ADR-0330, ADR-0331, ADR-0332, ADR-0333, ADR-0335, ADR-0353, ADR-0373, ADR-0374, ADR-0375, ADR-0389, ADR-0399 |

## Context

`CREATE POLICY` defaults to `FOR ALL`. A catalog that writes one tenant-isolation expression and
says nothing about commands therefore gets a policy governing every command — and because such a
policy's `WITH CHECK` is NULL, its `USING` expression serves as the check for `INSERT` and `UPDATE`
as well. Every one of the **115** RLS-enabled `meta` tables is in that shape. So a tenant-context
session may `DELETE` its own rows from all 115, and that was not a decision anybody made; it is
what the default gives you.

For 99 of those tables a tenant deleting its own row is its own business. For **16** it is not:
`PLATFORM_RECORD_TABLES` is the set the Article 17 erasure deliberately **retains**, and its own
doc comment is this increment's whole argument —

> an auditor or a regulator reads these *after* the tenant is gone, and a deletion must not be able
> to destroy them.

That sentence was written about the **platform's** deletion and is enforced against it: the erasure
skips all sixteen by construction. Nothing said it about the **tenant's** deletion, and nothing
enforced it. Measured live as the non-owner `serving` role before this landed, on all sixteen: a
tenant-context `DELETE` removed exactly the rows the **owner** could see for that tenant, with a
cross-tenant `DELETE` at 0 and an unprovisioned tenant at 0 as controls. **The retention set and a
DELETE fence are one judgement at two layers, and only one layer was enforced.**

Three facts decide why this is a fence rather than a detector.

**`DELETE` is the one command whose abuse nothing detects.** An edited chain entry breaks its
Ed25519 signature, which `verifyStoredChainSignatures` is the only check in the stack to bind to the
stored columns (ADR-0371); ADR-0373 routes an unreadable entry into the verdict; ADR-0374 does the
same for an unreadable anchor; ADR-0399 refuses an anchor edited into a valid-shaped lie. A
**deleted** row is caught by none of them — ADR-0375's own open end records that every anchor
`DELETE`d reads `verified` with `witness=null`, and the formatter then prints *"not checkable (no
checkpoint yet — run the checkpoint scheduler)"* for a scope whose checkpoints were destroyed. So
the line is **prevent what cannot be detected; keep detecting what can.**

**No workspace rule could have found this, structurally.** `SQL_STATEMENT_KINDS` is
`["insert", "conflict_update", "update", "select"]` — there is no `delete` member — so a `DELETE` is
invisible as a *statement* to all twelve rules in `packages/testing/src/strategy/` and appears only
in the weaker `references` list. Thirteen readings of the fake-connection blind spot are on file in
CLAUDE.md and this is a fourteenth: what is missing is not a column, a value, a name or a session
setting but a **command**.

**And `RlsPolicy.permissive` was a complete mechanism with no producer.** It was declared
(`types.ts`), emitted as `AS PERMISSIVE`/`AS RESTRICTIVE` (`emit.ts`), introspected
(`introspection.ts`), canonicalised (`canonical.ts`, defaulting to permissive) and diffed
(`diff.ts`, reason `"permissive"`) — and `grep -c "permissive:"` over `meta-schema.ts` answered
**0**. This repository's most-found shape, in the exact field this fence needs.

## Decision

**A table the Article 17 erasure retains because it outlives its tenant accepts no `DELETE` from
that tenant.** Sixteen restrictive policies, one per `PLATFORM_RECORD_TABLES` member, built by one
helper:

```sql
CREATE POLICY "<table>_no_tenant_delete" ON "meta"."<table>"
  AS RESTRICTIVE FOR DELETE USING (false);
```

`retainedRecordNoTenantDelete(table)` in `meta-schema.ts` is the one definition of that shape, and
`using: "false"` rather than a `tenant_id` comparison because **the subject is the command, not the
row**: a restrictive policy is ANDed with every permissive policy that matched, so this denies the
command outright and leaves the isolation arm's other three commands exactly as they were.

The set is **derived, not listed**. `tenantDeleteFencedTables()` reads it back off the catalog by
the structural predicate `permissive === false && command === "DELETE"` — deliberately not by policy
name, because a name is a convention and this is a property of the emitted SQL (ADR-0399's reason:
the name-filtered census of the exposed tables is 78 against a structural 115, and the filtered
figure was carried in this repository's own notes for two increments).

`@crossengin/kernel` cannot import `PLATFORM_RECORD_TABLES`, which lives in a package that depends
on it, so **`pg-record-retention.ts` gains a third half** — the rule that already owns exactly this
cross-package comparison, reading both sides from disk as text for its own stated reason. Two new
findings, compared both ways: `protected_table_unfenced` and `fenced_table_not_protected`. The
second is the one a one-way comparison would miss, and it is the dangerous direction, because a
fence on a table with a legitimate tenant-context `DELETE` writer is a **route that reports success
and does nothing**.

`UPDATE` is deliberately left open, with its reason: **five** of the sixteen have an `UPDATE` or
`ON CONFLICT … DO UPDATE` writer in the workspace, so a blanket `UPDATE` denial would refuse writes
this repository performs — and on the chain an `UPDATE` is detected where a `DELETE` is not. The
axis is the **writer** and not the policy arm, which is the correction below.

## Alternatives considered

**Narrow the `ALL` arm to three commands** (`SELECT`/`INSERT`/`UPDATE`), which is what the backlog
prescribed. **Not refused, and the scouting brief that said it would be refused was wrong** — this
is recorded because a refuted remedy is the kind of claim an increment spends itself on. Measured
through the real planner: keeping the policy's name gives **3 steps / 0 unreconciled** (one
`replace_policy` emitting `DROP POLICY …; CREATE POLICY … FOR SELECT …` in a single statement, plus
two `create_policy`), exactly the shape ADR-0331 established; only *renaming* the arm leaves 1
unreconciled with manual SQL **forever**, because `allowLoosening` is read at exactly one site and
reaches a type change's blocking foreign keys, never `policy_removed`. So both candidates are
reconcilable and they are **behaviourally identical** — both leave `SELECT`/`INSERT`/`UPDATE`
reaching the tenant's own rows and remove `DELETE`. The restrictive form wins on measurement and
legibility, not on necessity: one added policy per table against three, no `DROP` of a live
isolation arm, and a catalog that **says** `DELETE` is denied rather than implying it by absence.
At the sixteen-table scope that is 16 steps against 48; applied to all 115 it would be 345.

One hypothesis about the narrowing was raised and **refuted**, and it is worth recording because it
sounds right: replacing an `ALL` arm (whose `USING` doubles as its `WITH CHECK`) with a `USING`-only
`FOR UPDATE` arm does **not** let a tenant move a row into another tenant's scope. Postgres applies
the `UPDATE` policy's `USING` to the old row and, with no `WITH CHECK` declared, **re-uses that same
expression as the check on the new row**. So the narrowing is not unsafe; it is merely dearer.

**A catalog-wide fence over all 115, or over the 109 with no confined `DELETE` writer.** Refused on
measurement. `meta.operate_entity_records` is in the 115, carries exactly one `ALL`-scope policy
with a NULL check and no platform arm, and its `DELETE` writer — `entity-ops.ts:195` through
`entity-store.ts:134`'s `withTenantContext` — is the **shipped** `--store pg` entity-delete route.
Measured: `DELETE 1` without a fence, `DELETE 0` with one. Five further tables are in the same
state (`operate_entity_links`, `notification_preferences`, `notification_fax_observations`,
`gateway_idempotency_records`, `tenant_data_keys`). The 109 *could* be fenced and are not, because
the argument above is about records that outlive their tenant and a `slo_evaluations` row is not
one: **a denial needs a reason, not an opportunity.**

**`FORCE ROW LEVEL SECURITY`, which the backlog offered as a narrower variant for the forensic
tables.** Refused, and **the first refutation drafted for it was itself wrong** — recorded because
this register's own discipline is to aim a refuter at the corrections, and here one found a claim of
mine. The draft said FORCE would make `eraseSharedTablesWithin` refuse
`rls_would_confine_this_session` and so render the Article 17 erasure unrunnable. That cannot
happen for this variant: the erasure's probe asks about **its own targets**, and these sixteen
tables are precisely the retention set it never targets. The claim is true only of a *catalog-wide*
FORCE, which is not what was proposed.

The real refutation is stronger and is three measurements.

**FORCE does not close the defect at all.** The exposure is a *tenant-context* session, and all
FORCE does is make the owner into one. Measured on a FORCEd table owned by a non-superuser: with no
tenant context `DELETE 0`, and **with that tenant's own context `DELETE 1`** — so a FORCEd owner
deletes its own trail exactly as the `serving` role does. FORCE is a confinement, not a fence; its
whole effect is *make the owner behave like the serving role*, which is the role that was already
exposed.

**It does nothing at all on the deployment that ships**, and the reason is narrower than "the owner
bypasses RLS": the compose's `api` and `migrate` share one env anchor whose `PGUSER` is the role
`initdb` created, i.e. the bootstrap **superuser** — and it is **`rolsuper` and not `rolbypassrls`**
that defeats FORCE. Measured: a `SUPERUSER NOBYPASSRLS` role on a FORCEd table with no tenant
context still answers `DELETE 2`. So no role attribute short of dropping `SUPERUSER` rescues it.

**And it is not expressible**, which the repository already knew: `emit.ts:255` says in so many
words that *"`TableRls` is `{enabled, policies}`"*, and `relforcerowsecurity` appears in no source
file, so nothing emits, introspects, diffs or plans it. Its unnamed cost, found by the same pass, is
that `emit.ts`'s own DDL confinement guard raises for a non-superuser owner on a FORCEd table — so
FORCE would break the migration path for the deployment it is supposed to protect.

**A fence gated on a platform write grant** (`restrictive unless app.platform_record_write is
claimed`). Refused because those grants are `PUBLIC`-scoped GUC settings any session can
`set_config`, which ADR-0332 states outright: claiming one is a *declaration*, not an
authorisation. A fence anyone can satisfy is not a fence.

**A fence conditioned on a tenant context being set.** Refused on measurement: it buys nothing.
With a tenant context the fenced `DELETE` is 0; with **no** tenant context a non-owner's `DELETE` is
0 anyway, because the `ALL` isolation arm already evaluates `tenant_id = NULL` and matches nothing.

## Consequences

The sixteen tables that hold the platform's evidence about a tenant can no longer be emptied by that
tenant. The three measured controls are untouched, and the Article 17 erasure, the chain appender and
every owner-connected writer are unaffected.

**The cost is that a refused `DELETE` is silent.** `DELETE` carries only a `USING` clause and no
`WITH CHECK`, so one denied by RLS returns `DELETE 0` with **no error code** — byte-identical to an
empty scope, which is this repository's own silent-zero class (ADR-0333, ADR-0389). An `INSERT`
refused by RLS raises `42501` and an operator sees it; this raises nothing. On a table nobody
deletes from that costs nothing, and it is the whole reason the set is sixteen rather than 109.

**On the deployment that ships, this changes nothing**, because that deployment connects as the
bootstrap superuser. The fence is for a least-privilege serving role — the configuration every store
in this repository is written for, and the one ADR-0389 found the job queue silently depending on
the absence of. That is stated rather than hidden: a reader who takes "the owner bypasses RLS" as
the bound is understating it, since a superuser bypasses even FORCE.

`UPDATE` remains open on all sixteen, by decision and not by omission.

## Implementation notes

**The live verification**, port 5470, PG 16, owner `crossengin` (bootstrap superuser), non-owner
`serving`, every arm rolled back. `own` is the owner's count of tenant A's rows — the ground truth
that makes the rest non-vacuous.

| | own | tenant DELETE | tenant UPDATE | cross-tenant DELETE | owner DELETE |
|---|---|---|---|---|---|
| **before**, 16 fenced tables | 1 each | **1 each** | 1 | 0 | 1 |
| **after**, 16 fenced tables | 1 each | **0 each** | 1 | 0 | **1** |
| **after**, 3 controls | 1 each | **1 each** | 1 | 0 | 1 |
| empty-scope control | 0 | 0 | — | — | — |
| `row_security_active` | serving `t`, owner `f` | | | | |

An exact complement: the sixteen go to zero and the three controls stay at one, in one run, with the
owner's path intact throughout.

**The migration is free.** Driving the real catalog through
`introspectSchema` → `diffSchema` → `planSchemaReconciliation` against a converged populated
database plans **16 `create_policy` steps, 0 unreconciled**, all sixteen apply, and the re-plan over
the policies is clean. No manual SQL is owed on an existing deployment, which is the one thing this
repository records as a defect by name.

**And the emit is additive by measurement, not by argument.** `emitBootstrapSql("meta",
META_TABLES)` answers **981** statements (from 964) and **213** `CREATE POLICY`s — which is
`115 ALL + 36 SELECT + 33 INSERT + 13 UPDATE + 16 DELETE`, so the histogram and the SQL agree — of
which **16** carry `AS RESTRICTIVE FOR DELETE USING (false)` and **0** carry `AS PERMISSIVE`
anywhere. That last zero is the one worth asserting: `emit.test.ts`'s pre-ADR-0400 comment worried
that producing `permissive` would change *every* existing policy's emitted SQL, and because
`canonical.ts` defaults an absent `permissive` to permissive and the emitter writes nothing for it,
no existing statement moved a byte. The catalog-derived set is checked three ways — the structural
predicate (`tenantDeleteFencedTables()` → 16), the emitted literal (16), and the text-derived set
`pg-record-retention.ts` reads from disk (16, equal to `PLATFORM_RECORD_TABLES`).

The structural census behind the Context is also re-derivable in one call, and it is what settled
ADR-0399's gloss: of the 115 `ALL`-scope arms with a NULL `WITH CHECK`, the naming families are
`_tenant_isolation` **78**, `_tenant_or_platform` **27**, a bare `_isolation` **8**, and **two** that
match no suffix at all (`operate_tenant_manifests_tenant_or_platform_review`,
`audit_integrity_verdicts_tenant_or_platform_audit`) — 78 + 27 + 8 + 2 = 115, five families rather
than three, so a `LIKE` filter built from that ADR's sentence would still miss two.

**Four measurement defects of my own, each corrected and each worth the next reader knowing.**

1. **A vacuous run read as a clean result.** Three attempts failed in setup — an illegal `kind`, a
   14-character fingerprint against a 64-hex CHECK, a duplicate `entry_hash`, a missing
   `meta.tenants` parent — and every count below printed `0`. Fixed with a **non-vacuity floor**
   asserting the fixture before measuring anything, and by putting the owner's own count in the
   output table, which is what caught defect 4.
2. **A "before" that was an "after".** The first probe created the restrictive policy and never
   dropped it, so the next run's baseline already carried the fence: `forensic_chain_entries` read
   `deleted=0` *before* the fence and the exposure was nearly reported as refuted. Fixed by
   resetting at the **top** with an asserted `restrictive policies = 0` baseline. *A destructive
   probe that creates state must tear it down, or the next run's baseline is the previous run's
   result.*
3. **A measurement at the wrong layer.** `FORCE ROW LEVEL SECURITY` was measured against
   `crossengin` — the bootstrap **superuser** — and `rsa=false` was read as "FORCE does not confine
   the owner". FORCE *does* confine a non-superuser owner; what it cannot touch is a superuser.
   Separating the three roles is what produced the FORCE refutation above, and the distinction is
   load-bearing for the shipped deployment.
4. **A fixture that landed at the wrong scope.** The generator selected NOT NULL defaultless
   columns, and six of the sixteen declare `tenant_id` **nullable** (NULL means platform scope,
   ADR-0331) — so it omitted the column and those six rows landed at platform scope, making the
   probe vacuous on exactly the six tables that matter most, the chain and the audit log among them.
   The owner's-count column is what surfaced it.

**Mutation-checked across all three enforcement sites in one move.** Deleting a single line —
`retainedRecordNoTenantDelete("tenant_tombstones"),` — fails **7 tests in 3 packages**:
`@crossengin/testing` reports the live tree as `protected_table_unfenced:tenant_tombstones` (so the
new arm fires on the real catalog and not only on its fixture), `@crossengin/kernel` fails the
emitted-literal partition and the declared-field partition, and `@crossengin/kernel-pg` fails the
narrowed-name count and the permissive partition. Reversed by the exact inverse string replacement
with the occurrence count asserted in both directions, and the file confirmed **byte-identical** by
`md5sum` afterwards — never `git checkout --`, which on a tree carrying several hundred uncommitted
lines would discard them with no way back.

The fixture itself is **derived from each table's own constraints** rather than hand-written, after
hand-writing produced four CHECK violations on one table: a value-set CHECK supplies its own first
admitted member, a `^[0-9a-f]{n}$` regex supplies `n` hex characters varying by tenant (because such
a column may also be UNIQUE), and a table whose insert still fails is **reported by name** rather
than silently skipped. 19 of 19 for tenant A.

**Three test pins moved, and two of them were pinning something false.**
`emit.test.ts`'s *"writes no AS PERMISSIVE or AS RESTRICTIVE anywhere"* and `canonical.test.ts`'s
*"leaves every policy in the real catalog permissive"* were both true statements about a mechanism
with no producer, so the only thing the catalog could demonstrate about `declaredPolicyPermissive`
was its default. Both become **partitions** rather than flips, because the dangerous direction is a
*seventeenth* restrictive policy nobody chose, which `.toEqual([])` cannot see and a count would
hide. And `meta-schema.test.ts` asserted of `META_AUDIT_INTEGRITY_VERDICTS` that it had *"no
`UPDATE` arm **and no `DELETE` arm**, so a platform verdict is immutable by policy once written"* —
**the inference is false**: an absent `DELETE` arm denies nothing while an `ALL`-scope arm is
present, because `FOR ALL` governs every command. The absence was read as a denial for three
increments. That same test's comment already ended *"could forge a `verified` verdict for any
tenant, flip a `compromised` one, **or delete it**"* — ADR-0332 closed the forge and flip halves for
another tenant's rows, and the delete half for a tenant's own stayed open until now.

`canonical.test.ts`'s `NARROWED_NAME` is `/(_platform_(audit_)?(read|write|update)|_no_tenant_delete)$/`
and its count moves 82 → 98. The sixteen are the first narrowed arms there that **deny** rather than
elevate: all 82 above widen what a platform session may do, and these narrow what a tenant session
may do, which is why they are the catalog's first restrictive policies.

**A finding in passing, in the same family and not about the fence.**
`PostgresDesignJobStore.deleteExpired` carries the doc comment *"Platform-wide retention sweep —
spans tenants, so it must NOT run under a tenant RLS context."* Measured against
`meta.operate_design_jobs`, which carries only the isolation policy: as the non-owner unscoped, as
the doc instructs, **`DELETE 0`**; as the owner, `DELETE 1`; as the non-owner *with* a tenant
context, which the doc forbids, `DELETE 1` confined to that tenant. So the sweep deletes nothing on
a least-privilege deployment and **its own doc comment is what makes it vacuous**. `tenant_id` is
NOT NULL there, so ADR-0389's proof applies: a platform `DELETE` arm requiring `tenant_id IS NULL`
would admit no row. The honest fix is per-tenant iteration. Left open rather than fixed here,
because it is a different subsystem and a different class of remedy.

## Open questions

1. **`UPDATE` on the eleven members of the sixteen that nothing updates.** **The first draft of
   this question was wrong in both of its figures, and correcting it changed the question's own
   axis** — recorded rather than quietly fixed, because it is this register's P3.1 class landing on
   the increment that cites it twice.

   The draft said *"six carry a declared platform `UPDATE` arm and must keep it; the other ten take
   no `UPDATE` from any writer."* Measured from the catalog, **two** carry a declared platform
   `UPDATE` arm (`crypto_keys`, `access_review_templates`) and not six —
   `certification_reports` carries `SELECT` + `INSERT` only, and five of the six access-review
   tables carry nothing but the isolation arm. And measured through the repository's **own**
   scanner (`scanWorkspaceSql()`, 266 statements) rather than a grep, **five** of the sixteen have
   an `UPDATE` or `conflict_update` writer: `crypto_keys` (2), `gdpr_deletion_requests` (2),
   `access_review_evidence` (2), `access_review_campaigns` (1), `access_review_items` (1).

   The two sets are nearly **disjoint** — their intersection is `crypto_keys` alone — which is why
   the policy arm was the wrong question. Three of the five writers sit on tables with **no**
   platform `UPDATE` arm, so they write through the **isolation** arm as a tenant-context session,
   and a restrictive `FOR UPDATE` there would break a live writer silently (`UPDATE 0`, the same
   silent zero this fence pays for `DELETE`). Conversely `access_review_templates` carries a
   platform `UPDATE` arm and has **zero statements of any kind** — it is a declared-writerless
   table, so its arm protects nothing.

   So the honest candidate set is **11**, the sixteen minus the five with writers, and the question
   is still worth asking: on those eleven a restrictive `FOR UPDATE` would prevent the tamper
   ADR-0374 currently only *detects*. Two things make it a separate increment rather than a line
   here: a restrictive `FOR UPDATE` carries both `USING` **and** `WITH CHECK`, so its behaviour is
   not this one's shape, and the writer census above is a statement about *today's* workspace where
   the `DELETE` census is a statement about the catalog — so it needs the fence to be derived from
   something a future writer cannot silently falsify.

   **The grep that produced the wrong figure is worth naming**: a pattern over
   `UPDATE\s+(\$\{\w+\}|meta)\.` returned **0 sites for all sixteen**, because `key-registry.ts`
   writes `UPDATE ${this.schema}.${TABLE}` with `TABLE` a module constant — the very resolution
   `workspace-sql-scan.ts` exists to perform. A scan whose pattern is narrower than the artifact it
   measures answers zero and reads as a clean result, which is this ADR's own measurement-defect 1
   one layer out.
2. **The 109 unfenced exposed tables.** Each has no confined `DELETE` writer, so a fence would cost
   nothing mechanically and would say nothing either. Whether any of them holds records a tenant
   should not be able to destroy is a per-table judgement, and the right output of making it is
   probably additions to `PLATFORM_RECORD_TABLES` rather than a second list.
3. **The silent zero.** A `DELETE` this fence refuses is indistinguishable from an empty scope, so a
   client whose route is wrongly fenced sees success. Nothing in the repo can detect that, and the
   only general answer is a rule over the `DELETE` statements the workspace issues — which needs
   `SQL_STATEMENT_KINDS` to gain a `delete` member first.
4. **`SQL_STATEMENT_KINDS` has no `delete`**, so none of the twelve rules can see a `DELETE` as a
   statement. Adding it would let `pg-column-coverage.ts` check a `DELETE`'s `WHERE` columns and
   would give question 3 its mechanism; it is a scanner change with a census behind it, since every
   rule reading `scanWorkspaceSql().statements` would start seeing a new kind.
5. **`row_security_active` versus FORCE for a non-superuser owner.** The fence is inert for an owner,
   and the `--store pg-columns` deployment *requires* its serving role to own the entity tables —
   but not the `meta` ones. Whether a column-store deployment's serving role is confined on `meta`
   was not measured here, and it decides whether the fence is live on that configuration.
6. **The `operate_design_jobs` sweep above**, which needs per-tenant iteration and is unrelated to
   the fence except in sharing ADR-0389's class.

## References

- ADR-0332 — the platform write split, whose `ALL`-arm reasoning this extends to `DELETE`
- ADR-0335 — `PLATFORM_RECORD_TABLES` and `pg-record-retention.ts`, the rule this adds a half to
- ADR-0375 — the open end recording that a deleted anchor reads `verified`
- ADR-0389 — the unsatisfiable platform write arm, and *a write path is only fixed as far as the
  read that finds the row again*
- ADR-0399 — the structural census of 115 against the name-filtered 78
