# ADR-0379: A claim the erasure cannot make

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-20 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0316 – ADR-0331 (the Article 17 run this corrects), ADR-0321 (the asynchronous runner and its `rejected`/`aborted` split), ADR-0328 (a declaration is the deployment's, not the caller's), ADR-0337 (the falsely-true-control direction), ADR-0359 (never offer a surface the server discards), ADR-0362 (a type annotation standing in for a check), ADR-0372 (a test asserting the defect as the intended behaviour) |

## Context

Register item P0.4: *"An Article 17 request naming one data subject erases the whole tenant."*

Every clause is true and the mechanism is worth stating exactly, because three plausible readings of
it are wrong.

`DeletionRunner` is the asynchronous Article 17 path: a verified `meta.gdpr_deletion_requests` row
becomes a call to `deleteTenantAtomically`, which empties **every** catalogued table carrying the
tenant's id and drops the tenant's schema. That is the whole of the pipeline's remit and it is not a
parameter. And `node.ts` passed it `kind: "data_subject_erasure"`, hardcoded, with a comment reading
*"unattended, so always the data subject's erasure — never a commercial wind-down, which is a
decision a person makes through the synchronous route."* That comment is about the *request's*
subject and says nothing about what the erasure reaches.

So every verified request destroyed the whole tenant and signed a proof saying one person's data had
been erased. The synchronous route could do the same on request: `DELETABLE_TOMBSTONE_KINDS` admitted
`data_subject_erasure` and `node.ts` passed `req.kind` straight through.

**Nothing downstream could catch it, and the reason is the finding.** `TombstoneRecordSchema`
*does* have a rule for that kind — it must reference a deletion request — and
`GdprDeletionRequestSchema.subjectIdentifier` is required, so the proof names its subject
transitively and is **internally consistent**. What no refinement anywhere bounds is that kind's
**scope**: a `DeletionScope` is a list of schemas and tables, so the contract can see *what* was
destroyed and never *whose*. A tenant-wide scope under `data_subject_erasure` parses, hashes,
verifies and anchors. Measured — a tombstone naming a schema, a table and 9,999 rows under that kind
is `safeParse` success.

Three corrections to how the item was recorded, each of which would have misdirected the work:

- **`subjectIdentifier` is not missing from the contract.** `TombstoneRecord.subjectIdentifier`
  exists and is `.optional()`, required for `user_deletion` and deliberately not for this kind,
  because this kind is identified by its request. `DeleteTenantInput` carries the field too and
  threads it to the assembler — and **no caller in the workspace supplies it**, at either call site.
- **Threading it would make the record worse, not better.** A subject named on a proof whose scope is
  every table would read as a per-subject erasure that *verifies*, where the unlabelled one at least
  lets a reader see that the scope and the claim disagree. ADR-0337's falsely-true direction.
- **There are two emitters, not one.** Fixing the runner alone would leave the synchronous route free
  to be asked for the same kind.

Exposure is bounded and worth recording: **no deletion flag appears on any shipped compose
`command:`** (both occurrences of the word in `deploy/docker-compose.yml` are comments), so no
shipped deployment ran this. `deploy/ORACLE.md` documents how to mount it, which is how a real
deployment reaches it.

## Decision

**A tombstone kind is refused when a tenant-wide erasure cannot truthfully perform it, and the
deployment declares what a verified request reaches.** Four parts.

**1. `TENANT_WIDE_ERASURE_HONOURS`** — a total map over `TOMBSTONE_KINDS` in the contracts package,
answering whether destroying a whole tenant is a truthful performance of that kind.
`tenant_deletion` and `scheduled_purge` are `true`; `data_subject_erasure`, `user_deletion` and
`abandoned_export_purge` are `false`. A total map so a sixth kind is a compile error that has to say
which side it is on, and an enum member is the right granularity because this is a property of the
**claim** — not of a deployment, a request or a store.

`tenantWideErasureRefusal(kind)` is the reader, returning the sentence or `null`. A function rather
than exporting the keyed-on-a-subset map, because every caller holds a plain `TombstoneKind` and a
`boolean` predicate narrows nothing — so each one would reach for a cast, which is ADR-0362's class.
Each sentence names **what the claim is about** and never a field to supply; a test asserts no
refusal contains `subjectIdentifier`.

**2. `deleteTenantAtomically` refuses at the `input` stage.** Before the transaction opens, so a
*returned* refusal still means nothing was destroyed — which is also what makes it deterministic for
`DeletionRunner`, which files a return as `rejected` and strands only a throw (ADR-0321). The
converse is refused beside it: a `subjectIdentifier` supplied with a kind the erasure *does* honour,
which is the wrong fix for the first refusal and the shape a future reader reaches for on seeing the
field unsupplied. Its detail must not echo the subject it refused (ADR-0373's rule for
`unreadableDetail`), which a test pins.

**3. `--deletion-subject-scope tenant|subject`**, required by the runner, no default. ADR-0328's
argument one question across: that flag says what the deployment *holds*, this one what a verified
request *reaches*, and neither is safe to assume — `tenant` destroys every subject's data when one
person asks, and `subject` cannot be performed at all. `subject` is **refused at parse** and by name,
naming the missing capability (register P1.4: `@crossengin/data-lineage` has zero importers, and
there is no SAR route, store or scheduler) rather than a flag to add. Refused at *parse* and not at
boot because nothing about the deployment changes the answer — ADR-0340's shape, not ADR-0338's: there
is no degraded-but-coherent version of an erasure that cannot find its subject.

It is in the vocabulary and refused, rather than left out so the flag has one legal value, because an
operator who needs it should find a declaration and a reason instead of reading a single legal value
as the platform's position.

**4. The runner emits the declared kind**, through `TENANT_WIDE_KIND_BY_SCOPE` — a one-member map so
the day a second scope becomes possible the second kind lands there and the compiler asks, rather
than a second `kind:` appearing beside a condition in `node.ts`. The subject is **not lost**: the
proof still carries `relatedDeletionRequestId`, and the request holds the subject. What it no longer
says is that only their data went.

And the synchronous route stops advertising the kind. `DELETABLE_TOMBSTONE_KINDS` is its own remit
minus what the map refuses — written down as a literal and **fenced in both directions by a test**,
not derived through a cast, because `filter` types as the full union and stating the narrower tuple
needs an `as`. The fence is non-vacuous: a test asserts the route's remit is still wider than what it
offers, so narrowing the remit by hand cannot retire the check while keeping it green.

## Alternatives considered

- **Option A: thread `subjectIdentifier` through and scope the erasure by it.**
  - **Pros:** closes the item as literally worded; the field already exists on the input.
  - **Why not:** nothing can scope an erasure to a subject. Knowing which rows belong to one is the
    data-lineage subsystem (register P1.4) — zero importers, six tables declared
    `unbuilt_subsystem` — so this is not a wiring step but a subsystem. Threading the field without
    it manufactures the *worse* record above.

- **Option B: refuse `data_subject_erasure` at the runner only.**
  - **Pros:** one line; closes the unattended path, which is the one nobody watches.
  - **Why not:** it would make **every** verified request refuse, which silences the only wired
    Article 12(3) instrument — `auditCompleted` and `isCompletedLate` walk `status = 'completed'`, so
    a path that can never complete is a path that is never audited for lateness. And it leaves the
    synchronous route able to ask for the same kind. The declaration is what lets the honest case
    keep working.

- **Option C: default `--deletion-subject-scope` to `tenant`.**
  - **Pros:** no existing deployment's boot changes; the kind is corrected silently.
  - **Why not:** `tenant` means one person's request destroys every other user in that tenant. That
    is honest where a tenant *is* one data subject and over-deletion otherwise, and it is a judgement
    only the operator can make — ADR-0328's exact reason `--deletion-capabilities` has no default.
    A silently-defaulted over-deletion is the defect with better labelling.

- **Option D: bound the kind's scope in `TombstoneRecordSchema` instead** (e.g. refuse
  `data_subject_erasure` with a non-empty `scope.schemas`).
  - **Pros:** the contract becomes self-sufficient; every stored proof is checkable against it.
  - **Why not:** it would refuse **after** both erasures had run. `assembleTombstone` is called
    inside the pipeline's transaction, so a contract refusal there is a throw, a rollback and
    ADR-0321's `aborted` — a request stranded `in_progress` under an Article 12(3) deadline, for a
    configuration error decidable before the transaction opened. The same reasoning ADR-0372 applied
    to `performed_subsystem_self_exempted`. Worth adding *as well*, later, for stored records; it is
    the wrong place for the gate.

- **Option E: `deferred` rather than `rejected` for a request that cannot be honoured.**
  - **Pros:** keeps the request live and its Article 12(3) clock visible, rather than closing it.
  - **Why not:** `deferredUntil` is required for a deferral and there is no date at which the
    capability arrives, so the code would have to invent one — ADR-0317's silence-with-a-default in
    a regulatory deadline. Moot in the shipped configuration anyway, since `tenant` completes.

## Consequences

- **Positive:** an Article 17 proof can no longer claim a subject-scoped erasure over a tenant-wide
  one. The runner's kind is a declaration rather than a hardcode, and the one surface that offered
  the kind no longer advertises it. The honest case still works end to end.

- **Negative:** `--deletion-runner-ms` now needs a second flag, so a deployment running the
  unattended runner fails to mount it until an operator makes the declaration — and the message says
  so. The synchronous route's `kind` enum narrowed from two values to one, so a caller explicitly
  passing `data_subject_erasure` gets a 400 where it used to get a destroyed tenant.

- **Unchanged:** the subject is still recorded, on the request the proof references. Nothing about
  which rows are destroyed changed — only what the record claims about them.

## Verification

**Offline.** 3 contract tests (totality, the exact honoured set, every refused kind carrying a reason
that names no field), a test pinning that the contract still *does not* bound the kind's scope — so
the map's reason for existing is not lost if a refinement is added later — 3 pipeline tests (all
three refused kinds, both honoured kinds, and the subject converse), 2 CLI tests, and the route's
both-ways derivation fence.

**Two existing tests asserted the defect as the intended behaviour** and are replaced by their
complement — ADR-0372's shape again. One checked that a `data_subject_erasure` with no deletion
request was refused *before the drop*; the other that one naming its request was **accepted with a
200**. A third, titled *"accepts only the two kinds a tenant-scoped delete can produce"*, asserted
`["tenant_deletion", "data_subject_erasure"]` — the defect written down as a specification.

A guard refusing `data_subject_erasure` with no request reference is **deleted** rather than kept: the
kind is no longer in the route's enum, so it could never fire, and a check that cannot fire reads as
coverage it does not provide (ADR-0361's reason for deleting `validateReports`' unreachable check).
The typechecker found it, which is the argument for the kind set being a narrowed type rather than a
runtime filter.

**Live**, on a throwaway PG 16.13 with the catalog applied, through the real HTTP routes and the real
runner on a 3s tick, with a real Ed25519 chain config and a six-key capability declaration.

*Before*, reproduced by a two-point mutation of the shipped tree (the runner's hardcoded kind and the
pipeline's fence), reversed afterwards by inverse string replacements with presence asserted first
(ADR-0367 — never `git checkout --`). Tenant `doomed2` held three records: Bob's, Carol's, and a
ledger account. **Bob** submitted and the request was verified:

```
kind=data_subject_erasure | request=dreq_2f9b6264… | rows=3 | tables=1
0 records left for tenant doomed2
```

A signed, anchored proof that one data subject's data was erased, over the destruction of Carol's,
who never asked.

*After*: the same flow on tenant `doomed` completes and stores
`kind=tenant_deletion | subject=(none) | request=dreq_8765a5ad… | rows=2 | tables=1`.

*The runner without the declaration*:
`[platform] --deletion-runner-ms requires --deletion-subject-scope (a verified request erases the
whole tenant here, and the proof has to say so); skipping` — and the server starts.

*The synchronous route asked for the kind*:
`{"error":"invalid_request","detail":["kind: Invalid enum value. Expected 'tenant_deletion',
received 'data_subject_erasure'"]}`, and `tenant_deletion` reaches the pipeline (409 `scope_empty` on
a tenant holding nothing).

**The map's own type refused the mutation**, which is worth recording as evidence rather than as an
inconvenience: restoring the hardcoded kind was `TS2322` against
`Readonly<Record<"tenant", "tenant_deletion">>`, so the mutation needed its annotation widened before
it would even build. The pre-fix line is a compile error in the post-fix tree.

Two incidental live findings, both pre-existing and both the pipeline's own fences doing their job:
as the **non-owner** `serving` role the erasure refuses `erase/rls_would_confine_this_session`
(ADR-0330's live observation, so the owner connection is what lets a kind reach the store at all),
and a tenant holding no rows refuses `assemble/scope_empty` (ADR-0350).

## Open questions

1. **A stored proof is still not checkable against its own scope.** Option D above — refuse a
   `data_subject_erasure` whose `scope.schemas` is non-empty — belongs in the contract *as well*, for
   records written by anything that is not this pipeline, and for the audit sweep. It must not be the
   gate, for the stranding reason given.

2. **`--deletion-subject-scope tenant` is over-deletion for a multi-user tenant and nothing says
   which tenants those are.** The declaration is deployment-wide while the fact is per tenant: a
   count of distinct subjects per tenant would make the consequence legible, and
   `meta.user_tenant_membership` can answer it. Until then the flag's own help text is the only
   warning.

3. **`DeleteTenantInput.subjectIdentifier` survives with no caller**, now fenced rather than removed.
   It is the correct field for `user_deletion`, a kind this pipeline refuses, so deleting it would
   remove the vocabulary a per-subject erasure will need. It is the shape
   `pg-unreachable-stores.ts` would call `prerequisite_of_unbuilt_surface` if that rule reached
   fields.

4. **Per-subject erasure remains unbuilt**, which is register P1.4 and the real answer to this item:
   GDPR Article 15 access, Article 20 portability and Article 17 *scoped* erasure all wait on
   `@crossengin/data-lineage` acquiring a reader. This increment makes the platform honest about not
   having it; it does not provide it.

5. **The two honoured kinds are not equally reachable.** `scheduled_purge` answers `true` and nothing
   emits it: no scheduler passes that kind, so the map's second `true` is a statement about what
   would be truthful rather than a live path. Worth knowing before someone reads the map as a census
   of what the platform does.

6. **`abandoned_export_purge` is refused here and has no erasure of its own**, so expired export
   artefacts are purged by nothing — the same gap `meta.tenant_data_exports` having no writer
   already records, now with a refusal in front of the wrong way to close it.
