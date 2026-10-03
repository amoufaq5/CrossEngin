# ADR-0316: Erasing a tenant's own schema, and asking Postgres what a cascade would destroy

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-03 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0255, ADR-0283, ADR-0290, ADR-0292, ADR-0313, ADR-0314 |

## Context

ADR-0314 gave a tenant serving its own activated manifest its own Postgres schema. Nothing ever
removed it, and nothing in `tenant-lifecycle` knew it existed — the deletion path never mentions
`schema_name`, and the only `DROP SCHEMA` strings anywhere in the repository were SQL-injection test
fixtures.

So the GDPR Article 17 flow issued a `TombstoneRecord` — a content-manifest hash and a `proofSha256`
over a `DeletionScope`, anchored, four-eyes, the full apparatus — while **every row of the tenant's
actual business data survived**. The tombstone was not incomplete. It was false, and it was
cryptographically signed.

What makes this worth an ADR rather than a one-line fix is that the contracts were already right.
`DeletionScopeSchema.schemas` existed. `TombstoneRecordSchema` already refuses a `tenant_deletion`
declaring no schema, table, bucket or backup. The vocabulary for telling the truth was in place and
there was nothing that could *produce* the truth to put in it. The gap was purely executional, which
is the kind that survives a contract review.

## Decision

**`surveyTenantSchema` → `probeCascadeCollateral` → `planTenantSchemaErasure` → `eraseTenantSchema`,
in `operate-runtime-pg`, beside the code that creates the schema in the first place.** Plus
`erasureDeletionScope`, which shapes the result into the `DeletionScope` fields this subsystem can
honestly account for.

### Surveyed exactly, before anything is dropped

The tombstone's hash commits to `rowCount`, `storageBytes` and the table list, so those are
`count(*)` per table — **not** `pg_class.reltuples`. An estimate would make the proof a statement
about roughly how much data used to exist. It is expensive and it runs once in a tenant's lifetime.

The survey takes no lock, opens no transaction and writes nothing, so a console can show an operator
the extent of what they are about to approve.

### `CASCADE`, and what a cascade would reach is **observed, not inferred**

`DROP SCHEMA … RESTRICT` cannot work: the schema holds tables with foreign keys to each other, so
RESTRICT refuses while any object remains. `CASCADE` is therefore required — and `CASCADE` is the
hazard, because it silently drops dependent objects *outside* the schema.

`probeCascadeCollateral` censuses every relation outside the schema, runs the cascade **inside a
savepoint**, re-censuses, diffs by oid, and rolls back. Anything that vanished is collateral.

This is the decision the rest of the ADR exists to justify, because the first implementation reasoned
over `pg_depend` instead and was wrong **twice, in both directions**, with each failure invisible to
the offline fakes and found only against a live cluster:

1. **Every primary key read as external.** `pg_depend.objid` is an oid in the catalog named by
   `classid` — for a constraint, a `pg_constraint` oid. Joining it to `pg_class` matched nothing, the
   dependent's schema came back NULL, and NULL was being treated as "outside". A tenant's own
   `account_pkey` was reported as collateral, so **no erasure could ever proceed**. Safe-looking and
   completely useless.
2. **A view in `public` was dropped silently.** Fixing (1) with `pg_identify_object(…).schema` — which
   does resolve a constraint's schema correctly — meant reading NULL as "not schema-qualified, so not
   collateral". But `pg_identify_object` returns **NULL for a rule**, and a rule is exactly how a view
   depends on a table. Measured: `rule _RETURN on view leaky` → `schema = NULL`. So the one case the
   check exists for went straight through, and a view over a tenant table in another schema was
   destroyed without a word.

Inferring requires knowing, per `classid`, which catalog `objid` lives in and how to walk from there
to an owning schema — for constraints, rules, triggers, defaults, indexes, sequences, publications,
and whatever Postgres adds next. Getting it wrong in the permissive direction destroys somebody
else's data. Asking Postgres cannot be wrong about a class nobody thought to enumerate.

This is the same move ADR-0292 made for index predicates: attach it, let Postgres deparse it, roll it
away — rather than write a SQL parser. The cost is running the cascade twice, against a tenant that is
erased once.

### Refused in the cheap ways before the expensive one

The erasure plans **twice**, deliberately. The first pass has no collateral to judge, so it sees only
the refusals that need no probe — a schema name that is not a tenant schema, one that decodes to a
different tenant, a missing second person. Those settle before the trial cascade, because
trial-dropping a tenant's schema for a caller who may not erase it is work nobody asked for against
data they are not entitled to touch, rolled back or not.

Four refusals, none recoverable by retrying:

| Reason | What it stops |
|---|---|
| `not_a_tenant_schema` | a mistyped override dropping `meta`, `public` or the shared boot schema |
| `schema_not_this_tenant` | erasing *a* tenant rather than *this* tenant — the derivation is reversible, so this is checked, not trusted |
| `four_eyes_violated` | one person with one credential destroying a tenant's data |
| `external_dependents` | the cascade reaching past the tenant |

An **absent** schema is not a refusal. It is `alreadyAbsent`, with no refusals and no statements:
nothing to do is not a problem, and a caller tells the two apart by `refusals.length`.

### Verified gone, inside the transaction that dropped it

Under the same per-tenant advisory lock `applyTenantManifestSchema` takes — which stops a concurrent
activation from re-creating the schema between the drop and the check, and more importantly *after* a
tombstone has asserted its absence. The survey an operator approved is re-run under that lock, because
the one they read was already stale. Then the drop runs, then absence is confirmed, and only then does
the transaction commit. A `DROP` that reported success while the schema remained would produce a
signed tombstone for live data, so it throws and rolls back instead.

### Reachable, four-eyes, recorded

`GET /v1/platform/tenants/{id}/schema` and `POST /v1/platform/tenants/{id}/erase-schema`
(`--tenant-erasure-routes`, `--tenant-erasure-role`, default **nobody**).

- The survey is a **separate, read-only route**, because a destructive action whose extent an operator
  cannot see first is one they approve blind.
- `executedBy` is the authenticated caller and is never read from the body; `approvedBy` comes from the
  body and must differ. The route cannot be driven by one person holding one credential.
- The body must repeat the tenant id as `confirmTenantId`. An irreversible action should not be one
  mistyped path segment away.
- **The recorder is required.** Destroying a tenant's data unrecorded leaves the deletion with no
  provenance, which is what a tombstone exists to supply. An erasure that succeeds and cannot be
  recorded returns **500 `erasure_unrecorded`** naming exactly that, with the scope attached and an
  instruction not to issue a tombstone from it — because a 200 would license a proof with nothing
  behind it and a 503 would read as "nothing happened", which is the one thing no longer true.

These routes do **not** transition the tenant to `deleted`. That state is reachable only through
`pending_deletion`, and the console's own map excludes it on purpose. Erasing the schema is the step
that *earns* the transition; it is not the transition.

## Alternatives considered

- **Option A:** `DROP SCHEMA … CASCADE` at the call site.
  - **Pros:** one line.
  - **Cons:** no measurement, so the tombstone's figures are invented; no four-eyes; no guard against
    dropping `meta` through a mistyped override; no check that it worked; and a cascade reaching into
    `public` with nobody watching.
  - **Why not:** every one of those is the reason this is a module.

- **Option B:** infer collateral from `pg_depend`.
  - **Pros:** read-only, fast, one query, no trial cascade.
  - **Cons:** wrong twice in opposite directions (above), each failure invisible offline, and the
    second one destroys data in another schema.
  - **Why not:** tried, measured, abandoned. A guard whose correctness depends on enumerating every
    catalog that can hold a dependent is a guard that will be wrong again.

- **Option C:** `DROP SCHEMA … RESTRICT` and let Postgres refuse.
  - **Pros:** Postgres decides; no probe.
  - **Cons:** RESTRICT refuses while *any* object remains in the schema, including the tenant's own
    tables — so it refuses every real erasure. It cannot distinguish internal from external, which is
    the entire question.
  - **Why not:** it answers a different question.

- **Option D:** capture the `NOTICE` lines `DROP … CASCADE` emits ("drop cascades to view
  public.leaky").
  - **Pros:** Postgres's own account of what it dropped, no census needed.
  - **Cons:** notice text is a presentation surface, truncated past a threshold, and localised by
    `lc_messages`. Parsing it is a parser again, over a less stable grammar than SQL.
  - **Why not:** the oid diff is structural and locale-independent.

- **Option E:** put the erasure in `tenant-lifecycle`, next to the tombstone.
  - **Pros:** the deletion flow owns its own execution.
  - **Cons:** `tenant-lifecycle` is a contracts package — no sockets, no SQL — and the schema's naming,
    locking and introspection all live in `operate-runtime-pg`. Moving the knowledge would duplicate
    `tenantSchemaName` and the advisory lock, which is what ADR-0284 exists to prevent.
  - **Why not:** the drop belongs beside the create. `erasureDeletionScope` is the seam between them.

- **Option F:** have the erasure also transition the tenant to `deleted`.
  - **Pros:** one call completes the deletion.
  - **Cons:** the schema is one of several things a deletion must account for — object storage, backup
    generations, search indexes, cache keys all have their own owners. A module that marked the tenant
    `deleted` on the strength of its own part would reintroduce exactly this ADR's bug one level up.
  - **Why not:** `erasureDeletionScope` returns a *partial* scope, and returns it as a partial on
    purpose: a zero from here would read as "none" rather than "not asked".

## Consequences

- **Positive:** a tenant deletion can be true. The tombstone's `schemas`, `tables`, `rowCount` and
  `storageBytes` are measured from what was actually destroyed, confirmed absent before the commit.
  The cascade cannot silently reach another schema, and the guard is empirical rather than a model of
  `pg_depend` that will drift.
- **Negative:** the cascade runs twice, and the row count is a full `count(*)` per table — so erasing
  a large tenant is slow. Deliberate: it happens once, and both costs buy a figure a cryptographic
  proof commits to. The trial cascade also takes the same locks the real one would, briefly, inside
  the savepoint.
- **Neutral:** `erasureDeletionScope` is a partial scope and the caller merges. There is still no
  executing deletion *flow* — no deletion-request store, no scheduler, no tombstone writer — so this
  is the step, reachable and recorded, not the pipeline.
- **Reversibility:** none, by design, for the data. The *feature* is a flag defaulting to off with no
  role granted, so a deployment that does not configure it cannot reach the routes at all.

## Implementation notes

- `packages/operate-runtime-pg/src/tenant-schema-erase.ts`;
  `apps/operate-server/src/tenant-erasure-routes.ts`.
- `ERASURE_PROBE_SAVEPOINT` is released in a `finally`, so the trial cascade never outlives the probe
  even when the drop throws.
- `EXTERNAL_RELATIONS_SQL` censuses `relkind IN ('r','p','v','m','f','S')` outside the schema. Function
  bodies are not dependency-tracked by Postgres, so a function referencing a tenant table is not
  collateral and is correctly absent.
- `--tenant-erasure-routes` is the **third** flag that had to be added to `needsAuditEmitter`
  (ADR-0288, ADR-0313). The named predicate and its per-flag test caught it this time, which is what
  it was extracted for.
- Verified live on a throwaway cluster against a populated tenant schema with a composite foreign key
  and RLS: the tenant's own primary keys and foreign key are **not** collateral; a view *and* a
  materialised view in `public` **are**, and both survive the probe's rollback with the tenant's 25
  rows intact; the erasure refuses while they exist and refuses `executedBy === approvedBy`; after
  they are dropped it erases 26 rows / 65,536 bytes, reports that scope, and a fresh query confirms the
  schema gone; a second call reports `alreadyAbsent`; `meta` (144 tables) and `public` are untouched.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Nothing writes the tombstone. `erasureDeletionScope` produces the scope and no code assembles a `TombstoneRecord` from it, so the proof is still issued by hand. | amoufaq5 | _unscheduled_ |
| Object storage, backup generations, search indexes and cache keys are still unaccounted for in a `DeletionScope`. Each needs its own erasure with its own measurement. | amoufaq5 | _unscheduled_ |
| A refused erasure leaves an operator to drop the collateral by hand. Should the refusal offer the `DROP` statements, as ADR-0290's `unreconciled` does? | amoufaq5 | _unscheduled_ |
| `count(*)` over a large tenant is slow and holds a transaction open. A bounded or sampled mode would weaken the proof; is that ever the right trade? | amoufaq5 | _unscheduled_ |

## References

- ADR-0255 (GDPR Article 17, tombstones and proof hashes), ADR-0283 (additive-only column migration),
  ADR-0284 (one naming derivation), ADR-0290 (report rather than guess), ADR-0292 (ask Postgres to
  deparse rather than writing a parser — the precedent for the probe), ADR-0313 (`needsAuditEmitter`,
  second instance), ADR-0314 (the per-tenant schema this erases).
- PostgreSQL: `pg_depend.objid` is an oid in the catalog `classid` names;
  `pg_identify_object(…).schema` is NULL for a rule; `DROP SCHEMA … RESTRICT` refuses while any object
  remains; savepoints and `ROLLBACK TO SAVEPOINT`.
