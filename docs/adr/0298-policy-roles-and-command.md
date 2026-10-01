# ADR-0298: What a policy applies to, and to whom (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0292 (expression reconciliation), ADR-0290 (meta-schema reconciliation), ADR-0291 (foreign-key reconciliation) |

## Context

ADR-0292 closed index and policy *expressions* and left one piece: *"A policy's roles and command
(`FOR SELECT`, `TO some_role`) are still neither declared nor compared; `RlsPolicy` has no field for
either."* Until now a policy narrowed in place from `FOR ALL`/`TO PUBLIC` to something else was
invisible: the drift report compared its name and, since ADR-0292, its `using` and `check` clauses,
and nothing else.

## Decision

- **Both fields optional, with the Postgres default as the meaning of absent.** `command` omitted
  means `ALL`; `roles` omitted means `PUBLIC`. An empty role list is treated as absent rather than as a
  grant to nobody. These are exactly what `CREATE POLICY` defaults to, which is what makes the fields
  free to add: every existing policy keeps emitting byte-identical SQL.
- **`PUBLIC` emits unquoted, every other role through `quoteIdent`.** `TO "PUBLIC"` names a role that
  does not exist; an unsafe role name throws rather than being interpolated.
- **Canonicalise both sides, as ADR-0290 and ADR-0292 established.** `pg_policy.polcmd` is a single
  char and `polroles` is an oid array in which PUBLIC is `{0}`. The mappings live in `canonical.ts`
  beside the type and `ON DELETE` canonicalisers; oids resolve to names in SQL, with `0` mapped before
  the join because it has no `pg_roles` row, and both `polcmd` and `rolname` cast to `text` — the
  ADR-0291 trap, where a `name`-typed column has no driver array parser.
- **Role lists are compared as sets.** `polroles` comes back in oid order, so a policy declared
  `TO app_writer, app_reader` stores them the other way round; order must not read as a difference.
- **Unknown is not drift.** `command` and `roles` are nullable on the introspected side, where null
  means *undetermined, never the default*: an unrecognised `polcmd`, or a role list whose resolved
  length differs from `cardinality(polroles)` because an oid resolved to nothing. `diffSchema` skips a
  null side entirely — the same rule ADR-0292 applies to an unrendered expression, and for the same
  reason: comparing a strict subset of a role grant would report a narrowing nobody made.
- **No new step kind.** A changed command or role list folds into `changedPolicies` and is repaired by
  the existing one-statement `DROP POLICY …; CREATE POLICY …;` — ADR-0292's rule, because a table with
  RLS enabled and no policy denies every row. `reconcile.ts` needed no change at all.

## Consequences

- **Verified three ways that the 139 existing tables are untouched**, which was the main risk:
  a sha256 of all 843 emitted statements and of the 107 `CREATE POLICY` statements is identical with
  the change in place and reverted; a durable test asserts every catalog policy declaring neither field
  emits exactly the pre-change statement, written against live `META_TABLES` rather than a fixture; and
  independently, 107 policies emit and **not one** contains a `FOR` or `TO` clause.
- **Verified live** against a real Postgres: a correctly-applied schema reports no drift with all 107
  policies introspecting as `ALL`/`["PUBLIC"]` and zero undetermined; a policy narrowed **in place,
  name unchanged**, to `FOR SELECT TO app_reader` was detected with reason `[command, roles]` and
  before/after, planned as one `replace_policy`, repaired, and back to no drift; the reverse direction
  — a catalog declaring a scoped policy against a default database — was detected and applied, and
  introspected back exactly as declared. Also confirmed that `TO PUBLIC, app_reader` collapses to `{0}`
  with a Postgres warning, so `{0}` is always alone.
- +48 tests (kernel 607, kernel-pg 327). 14 `LivePolicy` fixtures and one `PolicyRow` updated — found
  by grepping, since a field missing from a literal inside a spread is invisible to TypeScript and test
  files are not typechecked here.

## Follow-ups

- **A policy's `WITH CHECK` is still only exercised offline in the declared direction** (ADR-0292),
  unchanged by this.
- **`RlsPolicy` still cannot express `AS PERMISSIVE` / `AS RESTRICTIVE`.** `polpermissive` is
  introspectable and every catalog policy is permissive, so nothing drifts today — but a restrictive
  policy added by hand would read as permissive and be silently replaced.
- Nothing declares a non-default command or role list yet. The machinery is for a policy someone
  narrows, or a pack that wants one.
