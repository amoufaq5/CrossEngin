# ADR-0472: The boot surveys describe the session and the tenant they run for

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-25 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0383 (`ce_unaccent`), ADR-0397 (the per-tenant survey channel), ADR-0416 (`[search]` per store), ADR-0423 (document-store unique indexes), ADR-0424 / ADR-0440 (the confined app role), ADR-0438 (`lock_timeout` with bounded retry), ADR-0451 (residency on the authenticated tenant), ADR-0337 (a callerless class is a question) |

## Context

Six items from the register and the open questions of six ADRs. Each was re-measured against the
tree before anything was designed, and four of them were wrong in the direction that reads as
healthy.

1. **`[search]` claimed an index the shipped role cannot use.** On `--store pg-columns` the healthy
   line said *"the predicate and the trigram index are one expression"*. That is true of the
   expressions and says nothing about the plan, and the plan depends on who is asking. Since
   ADR-0424 and ADR-0440 the API connects as `crossengin_app`, which owns nothing and does not
   bypass RLS. Measured on PG 16 over 20,000 rows of `public.account`: as the owner the predicate
   is a `Bitmap Index Scan on account_name_utrgm`, and as `crossengin_app` with tenant context it
   is a `Seq Scan`. `ILIKE` is `texticlike`, which is not `LEAKPROOF`, so Postgres cannot evaluate
   it ahead of the policy's qual. The reach reasoning in the code had inferred this from ownership,
   which was ADR-0349's argument and stopped being true when the role split happened.
2. **`[search]` told an unreachable database to run `CREATE EXTENSION`.** `ensureUnaccentExtension`
   caught any error from the probe or the `CREATE`, classified it `refused`, and printed the
   by-hand `CREATE EXTENSION` remedy. A connection that was refused, or a TLS mismatch, therefore
   printed a remedy that would fail for the same reason. Separately, `SEARCH_EXTENSION_SERVES` was a
   total map that nothing read.
3. **The per-tenant survey covered two of the boot's ten findings.** ADR-0397 gave a tenant's
   activated manifest the sensitive-field and cursor-disclosure surveys and nothing else.
   Unchecked were list surfaces, unique enforcement, unserved sections, view-permission overrides,
   report surfaces, segregation of duties, jobs, at-rest storage, and where the tenant is served
   from. Two of them are not merely missing but answer wrongly when computed naively:
   - **Unique and reference enforcement on the shared document store.** Its unique indexes are
     built by the owner's `document-indexes` step from the *deployment's* manifest, and its
     reference checks follow the plan of the manifest the store was constructed with. On
     `--store pg` that is the deployment's manifest; on a `--store pg-columns` deployment the
     per-tenant **fallback** is `new PostgresEntityStore(conn, schemaOpt)` with **no manifest**, so
     it checks no reference at all. A unique or reference field that only the tenant declares is
     enforced by nothing. The pure `surveyUniqueEnforcement(manifest, "pg")` answers *enforced* for it, which
     is a falsely-true control.
   - **Jobs.** No producer reads a tenant's manifest. Measured: the scheduler, the entity-event
     sink and the invoke route are all constructed with the boot `manifest.jobs`. A job declared
     only by a tenant is enqueued by nothing and run by nothing.

   Before this change `tenantSurveyHasFinding` read
   `cursorDisclosure.verdict === "plaintext_disclosing"`. That comparison is a maintained list of
   one: a fifth cursor verdict would be classified *not a finding* without anyone deciding so.
4. **The five file-taking flags reported failures that named nothing.** `node.ts` ran
   `JSON.parse(await readFile(path))` inline for `--jwks-file`, `--plan-catalog`,
   `--deletion-capabilities`, `--deletion-escalation-config` and `--workflow-worker-config`. A
   missing file printed `fatal: ENOENT … '<path>'`, which names neither the flag nor what it was
   for. A malformed file printed V8's parser message, which names neither the flag nor the path,
   and quotes the file's content.
5. **`document-indexes` waited on every writer.** It issued `CREATE UNIQUE INDEX IF NOT EXISTS`
   for every planned index. `IF NOT EXISTS` is checked after the table lock is taken. Measured: with
   one session holding `ROW EXCLUSIVE` on `meta.operate_entity_records`, the statement for an index
   that already exists blocked until a 3 s `statement_timeout` cancelled it. On a busy deployment,
   every `up` therefore queued behind live traffic for indexes that were already there.
6. **`RegionRouter` was a class with no caller.** ADR-0451 moved residency to the authenticated
   tenant in `residency-gate.ts`. `RegionRouter` stayed exported, and `pg-unreachable-stores.ts`
   declared it `prerequisite_of_unbuilt_surface`, which implies a surface still to be built. No
   such surface is planned. The pure `decideRegionRouting` remains and is still called.

## Decision

1. **`[search]` asks Postgres whether this session is confined.** `probeSearchIndexReach` asks one
   question of one served entity table: `rolsuper OR rolbypassrls`, whether the table exists, and
   `row_security_active(to_regclass(...))`. The table is the first entity's table on
   `pg-columns`, and `meta.operate_entity_records` on `pg`. A total map over `rls_exempt`,
   `not_confined`, `confined` and `unknown` drives the line. The confined arm reads *"RLS confines
   this role on public.account — so ?q= and [contains] are a sequential scan on every entity table
   this store serves … texticlike is not LEAKPROOF"*. The index is deliberately not made readable
   to the confined role: making it so would require a `LEAKPROOF` operator or an owner-run path,
   and the brief excluded both. On `--store pg` the line is unchanged, because it already says no
   index can serve the fold, which is the stronger statement.
2. **An unreachable database names no extension remedy.** `isConnectionLevelError` treats as
   connection-level an error with no five-character SQLSTATE, a five-character Node errno (`EPIPE`,
   `EPERM` — no SQLSTATE class begins with `E`), and the SQLSTATEs raised only while a session is
   being established or is unusable: classes `08`, `57P` and `28`, and `3D000`. A connection-level
   error from either the probe or the `CREATE` answers `unreachable`. Any other error answers
   `refused` from the `CREATE` (keeping the superuser remedy) and `unreadable` from the probe. The line then says *"the database could not be reached … check the connection
   settings"* and contains no `CREATE EXTENSION`. `ensureSearchExtension` stops on `unreachable`
   rather than probing further. `SEARCH_EXTENSION_SERVES` is deleted, because it had no reader and
   the line is now driven by the outcome.
3. **The per-tenant survey runs every boot survey and reports only what the tenant contributes.**
   `surveyTenantManifest(manifest, base, ctx)` is pure. Its context is the deployment's manifest,
   `--store`, where the tenant is served from, the segregation-of-duties setting, whether a
   column key is configured, and `--allow-dangling-references`.
   - **Served from.** `TENANT_SERVED_FROM` has four values. `own_schema` is the column store.
     `own_schema_retained` means a re-activation was refused, so the tenant is served the last
     applied manifest. `fallback` is the JSONB document store. `shared` means no registry, so every
     tenant uses one store. `servedFromOf` maps `TenantServing`'s non-throwing arms onto these.
     Retained and fallback are findings. The store that the per-store surveys run against is
     derived from this value, not from `--store`.
   - **Whether a verdict is a finding is a total map.** There is one map per survey (cursor, list,
     unique, view, at-rest, served-from), and `TENANT_SURVEY_FINDING_KINDS` is a closed census of
     twelve kinds with a predicate each. A new kind is a compile error until it states its
     predicate.
   - **Inherited findings are not repeated.** A tenant that extends the deployment carries every
     boot finding, and the boot line has already reported those. For list surfaces, unique
     enforcement, sections, view permissions and report surfaces, the same survey runs over the
     deployment's manifest. A finding holds only when the tenant has a member whose signature the
     deployment's answer lacks. This rule produced the live result described below.
   - **The document-store gap compares plans, against what the serving store really checks.** It
     compares `planDocumentIntegrity` index names against the deployment's plan, and
     `(entity, field, target)` edges against `referencesCheckedBy`: the deployment's plan on
     `--store pg`, **nothing** on the pg-columns fallback (every tenant reference is reported,
     inherited ones included), and no reference finding at all under `--allow-dangling-references`,
     which the boot line already acknowledged.
   - **Jobs.** A tenant job missing from the deployment's manifest is *NOT served by this
     deployment*. One the deployment declares differently is reported as *divergent*, and the
     deployment's declaration is the one that runs.
   - **Segregation of duties.** It is a finding when the tenant's approve-class set differs from
     the deployment's.
   - **At rest.** `phi` on the shared plaintext store is reported as *stored in the CLEAR*, because
     ADR-0338's refusal answers for the boot manifest only. On the fallback the line says requests
     are refused instead.
   - **Rendering.** Each sentence comes from the boot formatter where one exists. The three kinds
     with no boot line are written in this module. Every line carries the tenant tag, and the
     survey is silent when there is no finding.

   `server.ts` emits `onSurvey` after the gateway is built, so the report survey reads the
   compiled `reportSurfaces`.
4. **`readFlagJsonFile(flag, path)`** answers `<flag>: cannot read <path>: <code>` and
   `<flag>: invalid JSON in <path>`. The second carries no parser detail, because V8 quotes the
   input and a config file may hold a secret. All five call sites use it. A text fence in
   `node.test.ts` asserts that no inline `JSON.parse(await readFile` remains and that each flag
   name is present.
5. **`ensureDocumentUniqueIndexes` reads the live set first.** An index that is present and valid
   counts as enforced and issues no statement. One that is present and invalid is reported
   `invalid_index` and not re-issued. A missing index is created inside a transaction under
   `SET LOCAL lock_timeout`, with ADR-0438's bounded retry (`applyStatementStop`, 5000 ms, 2
   retries, pauses of 1 s and 2 s). The catalog is re-read only if something was built. Running
   out of retries reports `failed` with the wait in the detail. No new outcome is added, so the
   unique-enforcement vocabulary is unchanged.
6. **`RegionRouter` and its declaration are deleted.** `decideRegionRouting` stays.

## Alternatives considered

- **Report the confined `[search]` state as a warning.** A confined role is the intended shipped
  posture, and the sequential scan is its cost rather than a fault. Warning would alert on every
  correct deployment. It stays at info, and the boot-time `EXPLAIN` is recorded below.
- **Give the confined role a `LEAKPROOF` wrapper around `ILIKE`.** This was excluded by the brief.
  It would also be a security decision about what a predicate may learn about rows the policy
  hides, which should not be settled inside a boot-line fix.
- **Treat only `ECONNREFUSED` as unreachable.** A TLS mismatch (`The server does not support SSL
  connections`) is equally connection-level and was measured. A shape test alone ("no
  five-character SQLSTATE") is not enough, which review found: a five-character Node errno such as
  `EPIPE` passes it, and an unknown role (`28000`) or database (`3D000`) arrives as a real SQLSTATE
  under `PGSSLMODE=disable` — measured live, where the default `prefer` negotiation wraps the same
  failure into a code-less `Error`. Both are handled by name. This change was checked with `PGHOST`
  pointed at a closed port, with `PGSSLMODE=require` against a server that does not support TLS,
  and with an unknown role and an unknown database under both `prefer` and `disable`.
- **Report every finding a tenant's manifest has.** This was the first version, and the live run
  refuted it. A tenant extending `erp-core` printed four `[reports]` lines about gaps in the
  deployment's own `erp-core` grants, once per tenant per activation, which repeats the boot line
  N times. The signature comparison removed them. The cursor-disclosure finding still repeats
  inherited fields; see open question 1.
- **Run the pure unique survey on the document store.** It answers *enforced*, because the store
  builds indexes, but those indexes come from the deployment's plan. That would be a
  falsely-true control (ADR-0337), so the plan comparison replaces it there.
- **Add a `lock_timeout_exhausted` outcome.** It would have to be added to the unique-enforcement
  vocabulary and to `node.ts`'s total refusal map. `failed` already carries the remedy (*re-run
  when it is quieter*), so the existing outcome is used.
- **Keep `RegionRouter` as a cache for a future post-auth check.** ADR-0451's gate already runs
  after authentication, and ADR-0337's test for a deletion is that the class is a second spelling
  of live code, which it is. Re-adding it later means adding back a class rather than recovering
  lost behaviour.

## Consequences

- On `pg-columns` as `crossengin_app`, `[search]` now states that `?q=` is a sequential scan, which
  is what the plan does. As the owner it says the role is RLS-exempt.
- A boot against an unreachable database prints one `[search]` line with no remedy that would fail.
- A tenant's activated manifest is surveyed for twelve kinds of finding. The survey is silent when
  the tenant contributes nothing.
- `document-indexes` on an unchanged schema no longer takes a table lock. A missing index waits at
  most about 18 s under contention and then reports `failed` instead of queuing indefinitely.
- `@crossengin/residency-runtime` no longer exports `RegionRouter` or `RegionRouteRequest`. There
  are no importers.

## Implementation notes

Verified live on PG 16, port 5444. The schema was applied by `crossengin apply` as the owner, then
`app-role.sql`, then `document-indexes`, then `column-schema --grant-to crossengin_app`, and the API
ran as `crossengin_app` (NOSUPERUSER NOBYPASSRLS, owning nothing):

- `--store pg-columns` as `crossengin_app`: `[search] public.ce_unaccent: present — … but RLS
  confines this role on public.account — so ?q= and [contains] are a sequential scan …`. As the
  owner (control): `… and this role is RLS-exempt`. `EXPLAIN` of the predicate on 20,000 rows:
  owner `Bitmap Index Scan on account_name_utrgm`, app role `Seq Scan on account`.
- `--store pg` as `crossengin_app`: the document-store line is unchanged.
- `PGHOST=127.0.0.2` (connection refused) and `PGSSLMODE=require` against a server with no TLS: each
  produced one `[search] the database could not be reached …` line, with no `CREATE EXTENSION`.
- `document-indexes` re-run with a session holding `ROW EXCLUSIVE` on
  `meta.operate_entity_records`: `32 enforced` in 0.68 s. The control, the pre-change statement
  shape (`CREATE UNIQUE INDEX IF NOT EXISTS` on a present index) under the same writer, was
  cancelled by a 3 s `statement_timeout`. With one index dropped and the writer held:
  `Project.project_code: NOT enforced (failed): lock timeout: waited 5000 ms, 3 time(s) …` in
  18.73 s. After the writer committed, the re-run built it and exited 0.
- Per-tenant survey, `--store pg --per-tenant-manifests`: an active tenant manifest extending
  `operate-erp/core` with one entity and a `theme` section, plus `CURSOR_ENCRYPTION_SECRET` set,
  produced exactly one line on the first request:
  `[tenant-manifest] tenant 01a2…: [manifest] … this manifest declares 1 of them: theme`. The same
  manifest without `theme` produced zero lines. Before the inheritance rule, the same tenant printed
  four inherited `[reports]` lines.

Review (adversarial) additions, live on the same cluster through `createNodePgConnection` and the
real `ensureSearchExtension`: an unknown role and an unknown database under `PGSSLMODE=disable`
arrive as `28000` and `3D000` and now answer `unreachable` (before the review they read
`unreadable`, *"?q= may answer 500"*, about a process that never got a session); the control,
`crossengin_app` on the real database, answers `present`.

Not verified live: the `at_rest` arm (tenant `phi` on the shared store), the `fallback` and
`retained` served-from arms, and the document-store gap. Each is covered by unit tests over the real
`planDocumentIntegrity`, `decidePhiStorage` and `servedFromOf`.

Packages: `operate-runtime-pg`, `residency-runtime`, `operate-server` and `testing`. Mutation
checks: flipping `fallback` in the served-from map fails 2 tests, and dropping the inheritance
comparison fails 2.

## Open questions

1. **Cursor disclosure and sensitive fields still repeat inherited findings.** Their base values are
   computed in `server.ts` over the tenant manifest alone. Comparing them with the deployment's
   needs the boot answers passed in, which is an extension of `onSurvey`'s inputs.
2. **A tenant's `phi` on the shared document store is stored in the clear, and nothing refuses
   it.** This change reports it. Refusing the activation would be ADR-0338's rule applied per
   tenant, and is a decision for a later increment.
3. **A tenant's jobs and unique fields on the shared store have no path to service.** Serving them
   needs producers that read tenant manifests and per-tenant indexes on a shared table. Each is its
   own increment.
4. **The search reach probe answers for one table.** That table stands for every entity table the
   store serves. This holds while every one carries the same policy and owner, and a manifest could
   make them differ.
5. **`document-indexes` exits 0 when an index fails under contention.** That is the pre-existing
   behaviour for every failure. Whether it should exit non-zero so `api` does not start without the
   index was not decided here.

## References

- `packages/operate-runtime-pg/src/search-function.ts`, `search-extension.ts`, `document-integrity.ts`
- `apps/operate-server/src/tenant-manifest-survey.ts`, `flag-json-file.ts`, `server.ts` (`onSurvey`), `node.ts`
- `packages/residency-runtime/src/router.ts`; `packages/testing/src/strategy/pg-unreachable-stores.ts`
