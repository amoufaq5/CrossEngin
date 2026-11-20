# ADR-0458: The Article 17 pipeline runs as a dedicated eraser role, and a released request backs off before it is reclaimed

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-20 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0453 (the owner connection and the release this closes three open questions of), ADR-0424 (the confined app role and the provisioning step this mirrors), ADR-0400 and ADR-0401 (the `DELETE` fences the grant set is derived from), ADR-0329 (the shared-table erasure and its confinement probe), ADR-0350 (the boot schema's entity tables), ADR-0301 (credentials never on argv), ADR-0362 (ask Postgres, do not compose its rule) |

## Context

ADR-0453 made an Article 17 deletion completable on the shipped stack by giving the deletion
pipeline its own connection, configured by `DELETION_PGUSER` / `DELETION_PGPASSWORD`. It left three
open questions this record closes.

**Question 3: the recommended credential was a superuser.** The documented value was
`POSTGRES_USER`, which the official image makes a `SUPERUSER`. So the one deployment configuration
that could complete a deletion also put a superuser credential in the internet-facing `api` process.
A compromise of that process would then yield the whole database server (`COPY … TO PROGRAM`
included), not only the ability to read past row-level security. The boot line named the cost. The
narrower role ADR-0453 described was "created by hand, a grant set not verified live", and
`app-role` did not create it.

**Question 2: released requests rotated behind fresh ones.** A released request was claimed after
every fresh one. A steady stream of new requests could therefore keep it waiting after its cause was
fixed, while its Article 12(3) deadline kept running. There was also no wait between attempts, so a
request whose cause was not yet fixed was retried on every runner tick.

**Question 5: `last_attempt_refusal` was stored and read by nothing.** The one column recording why
a deletion was handed back had no reader on any route. An operator asking "why has this request not
completed?" had to query the database.

## Decision

### 1. A dedicated eraser role, provisioned on every `up`

`deploy/postgres/roles/eraser-role.sql` provisions the role and the one-shot `eraser-role` compose
service runs it. The service runs after `app-role`, as the owner, and every `api` (including the
self-hosted-AI overlay's) waits for it. The role is `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
BYPASSRLS`, owns nothing and is a member of no role. `BYPASSRLS` is the one attribute the erasure
needs, because its probe refuses a session that row-level security confines — and it is also what
takes the restrictive `DELETE` fences out of play for this role, so **the absence of a grant is the
only protection the retained tables have against it**. That is why nothing below is broader than a
statement the pipeline issues.

It holds exactly the privileges the pipeline uses:

- `SELECT` and `DELETE` on every `meta` table that carries a `tenant_id` column and has no
  restrictive `FOR DELETE USING (false)` policy. That is the erasure's own target set, because
  ADR-0401 made the fenced set equal to the retention union. `SELECT` because each `DELETE` returns
  the row's size and the confirm pass counts what is left.
- `SELECT` on the two statutory tables the erasure reads for its retention claim and never deletes
  from (`meta.invoices`, `meta.tenant_credits`), on `meta.tenants` (the tenant's state before the
  transition) and on `meta.forensic_chain_entries` (the tail the tombstone's entry links to).
- `INSERT` on the three tables the pipeline appends to: `meta.tenant_tombstones`,
  `meta.forensic_chain_entries` and `meta.tenant_lifecycle_events`.
- `SELECT` and `DELETE` on the boot schema's entity tables. These are recognised by the
  `<relname>_tenant_isolation` policy the column-store emitter writes, which is
  `censusBootSchemaTables`' signature.
- Nothing on `meta._meta_migrations`.
- No `UPDATE` anywhere. The request's transition and the tenant row's move stay on the app role's
  connection, as ADR-0453 placed them.

The grants are **recomputed rather than accumulated**: a `REVOKE ALL` then the grants, inside one
transaction. A table the catalog has fenced since the last run therefore loses its `DELETE`, and a
deletion running during `up` never sees the window between the two statements. **No default
privilege is granted**, and the one an earlier draft granted (`SELECT` on every future `meta` table)
is revoked on every run: a table `migrate` creates between two runs is ungranted until the step
re-derives it, which the boot probe names and the erasure refuses `table_privilege_missing` before
destroying anything. Whether a new table is an erasure target is a fact about its fence, which only
the catalog after `migrate` can answer. `deployment-defaults.test.ts` keeps the two named lists in
step with `STATUTORY_RETENTION_TABLES` and `DELETION_PIPELINE_PRIVILEGES`, in both directions.

The step **marks** the role it provisions (`COMMENT ON ROLE … 'crossengin:eraser-role'`) and, on
every run, before either early exit, **retires** any marked role `DELETION_PGUSER` no longer names:
`NOLOGIN NOBYPASSRLS`, every table, schema, database and default privilege revoked, and the marker
moved to `…:retired`. Retired rather than dropped, because `DROP ROLE` is irreversible; naming the
role again re-adopts it. Without this, unsetting the variable left a `LOGIN BYPASSRLS` credential in
the database indefinitely.

The script is **opt-in** and **upgrade-safe**:

- An empty `DELETION_PGUSER` changes nothing.
- A `DELETION_PGUSER` naming `POSTGRES_USER` (ADR-0453's documented configuration) is left alone and
  said once. The API's boot line then warns about it on every start.

Before touching any role, the script refuses, by name:

- a password that is empty, still the `.env.example` placeholder, shorter than 16 characters, or
  equal to the owner's or the app role's password;
- a name equal to the app role's;
- the eraser holding **any** role membership, read from `pg_auth_members` and naming the roles. A
  member of a `SUPERUSER` role can `SET ROLE` to it; a member of the app role inherits `UPDATE` on
  every `meta` table; a member of `pg_write_all_data` inherits `DELETE` on the fenced trail, which
  `BYPASSRLS` stops the fence refusing. Asked of `pg_auth_members` rather than through `pg_has_role`,
  which a superuser answers true for every role, so the check is right whatever the role's
  attributes are at that moment and needs no re-check after the `ALTER`;
- **any** role being a member of the eraser, which could `SET ROLE` past row-level security;
- the eraser owning a table in `meta` or `public`.

`.env.example` names the role `crossengin_eraser`, commented out, with a placeholder password. No
deletion flag is on the shipped command, so an uncommented line would provision a `BYPASSRLS` role
that nothing uses.

### 2. Membership in a superuser role is the attribute under another name, and any membership is breadth

The task asked whether membership confers the attribute. **It does not confer it, and it does not
need to.** `rolsuper` is not inherited, so `current_setting('is_superuser')` is `off` for a member.
But a member can `SET ROLE` to the superuser, and one statement later the session is one. So the
role script refuses such a membership, and the boot probe reports it as a third posture,
`superuser_by_membership`. It is asked in the same statement as the role's own attribute:

```sql
SELECT current_user AS role, current_setting('is_superuser') AS superuser,
       EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolsuper AND r.rolname <> current_user
               AND pg_has_role(current_user, r.oid, 'MEMBER')) AS superuser_member
```

`MEMBER` and not `USAGE`, because `USAGE` answers only for an inheriting grant, while `SET ROLE` is
available through a `NOINHERIT` one too (PG ≤ 15; PG 16's `SET FALSE` option narrows it, and
`MEMBER` stays the conservative question).

**`dedicated` is not "not a superuser".** The first version called any `rolsuper = false` role
dedicated, so a role holding `pg_write_all_data` or ownership of the catalog read as the narrow role
at info level. The same statement now also asks for every membership the role holds, whether it
owns or can update any `meta` table, and whether it holds `DELETE` on a fenced one; any of those
makes the posture **`broader`**, at warning level, naming each.

### 3. The `[deletion]` boot line distinguishes four cases

The probe still asks Postgres: `row_security_active` through the erasure's own probe, plus
`has_table_privilege` for the grants the erasure will use. The line distinguishes:

| Case | Level | What it says |
|---|---|---|
| dedicated role, can complete | info | `a dedicated role`, and every target table is *present, scoped, granted and unconfined* |
| superuser or member of one, can complete | warn | names the posture and the cost, and names `crossengin_eraser` as the narrower role |
| will refuse | warn | each cause with its remedy: confined, missing, unscoped, or a missing grant (`unprivileged`, remedy: re-run `up`) |
| unreachable | warn | as ADR-0453 |

A dedicated role that cannot drop some per-tenant schema also warns, naming the schema count, and is
*not* reported as "every deletion will be refused".

The snapshot of existing schemas answers only for tenants activated **before** boot, so the line
also asks the structural question: under `--per-tenant-manifests` or `--tenant-erasure-routes` it
asks whether the deletion role can use the role that creates those schemas
(`pg_has_role(…, 'USAGE')`, inherited ownership being what `DROP SCHEMA` needs), and says *it can
drop no per-tenant schema* when it cannot. The schema-erasure routes ask the same of the one schema
they are about to act on (`tenantSchemaDroppable`) and answer **`503 schema_not_droppable`** naming
`DELETION_PGUSER`, rather than surveying and then failing partway.

### 4. A missing grant is a named, retryable refusal

`probeSharedTableErasability` now also asks `has_table_privilege(…, 'SELECT')` on every target and
`has_table_privilege(…, 'DELETE')` on each erasable one. A statutory table is read and never deleted,
so it needs no `DELETE`. The **rest of the pipeline's** statements are asked too, through
`DELETION_PIPELINE_PRIVILEGES` (`SELECT` on `meta.tenants` and `meta.forensic_chain_entries`,
`INSERT` on the three append tables), in the same transaction and before the first `DELETE`: the
first version checked only the erasure's targets, so a missing `INSERT` on the tombstone surfaced as
a `42501` after every row had been deleted — a rollback, an unproven abort and a stranded request,
which is the exact failure this refusal exists to pre-empt. The lifecycle rows are asked only when
the pipeline was given a lifecycle store, since only then does it read `meta.tenants` or append the
event. A missing grant becomes the new refusal `table_privilege_missing`, raised
**before the first `DELETE`**. Without this refusal the cause was a `42501` mid-transaction: a rollback,
an unproven abort, and a request stranded `in_progress`. With it, `DELETION_REFUSAL_RETRYABILITY`
marks the refusal `retry`, so the request is released, which is ADR-0453's rule for a cause the
deployment can fix. The remedy is the next `up`.

### 5. A released request backs off, then competes on its deadline

`meta.gdpr_deletion_requests` gains two columns, both nullable with no default, and the contract
gains the two fields:

- `release_count INTEGER CHECK (release_count >= 1)`
- `retry_not_before TIMESTAMPTZ`

NULL means *never released*. A default would claim a release that never happened (ADR-0331).

The contract requires the two fields together, and requires a `lastAttemptRefusal` beside them. It
deliberately does **not** order `retryNotBefore` against `inProgressAt`. A reclaim re-stamps
`in_progress_at` after the previous release's `retry_not_before`, so that refinement made every
reclaimed row unreadable; it was found by the store tests and removed.

The release write computes the backoff in the store:

- `release_count = previous + 1`
- `retry_not_before = at + min(cap, base × 2^(count − 1))`, with the defaults
  `base = 60 s` and `cap = 1 h` — and **never later than `deadline_at − 24 h`**, the point at which
  the grace gate yields to the deadline (`GRACE_YIELDS_TO_DEADLINE_MS`). Without that cap, a request
  released inside its last day carried a `retry_not_before` past the instant the scheduler would
  otherwise have run it on deadline grounds, so the backoff could hold a request beyond the point its
  own Article 12(3) deadline made urgent. A release that lands inside that window waits nothing.
- guarded by `release_count IS NOT DISTINCT FROM $previous`, so two releases racing on one row
  cannot both count

The claim then filters on `retry_not_before IS NULL OR retry_not_before <= now` — where *now* is
the **store's clock**, bound as a parameter, in both the grace and the no-grace form (the no-grace
form used the database's `now()` against a value the store wrote from its own clock, so a skewed
clock moved the wait in either direction) — and orders by
`deadline_at, request_id`. So once the backoff elapses, an older deadline wins whatever the release
history. That closes question 2's starvation, and the order is the one
`idx_gdpr_deletion_due (status, deadline_at) WHERE status = 'verified'` already serves.

### 6. The retry history is on the route, and it is reason codes only

`requestHandle` carries `lastAttemptRefusal`, `releaseCount` and `retryNotBefore` (each `null` when
absent). It is the body of the read, pending, stranded, verify, reject and reconcile routes, under
their existing reader authorization. The value is `stage/reason` codes joined by `"; "`, and the
store **refuses any other shape at write time** (`RELEASE_REASONS_RE`, `contract_violated`). That
enforces the property on the **release** writer only: the reject path and the synchronous route also
write `last_attempt_refusal`, and a hand-written `UPDATE` can put anything there. So the route
enforces it again on **read** — a value that does not match the codes shape is withheld
(`lastAttemptRefusal: null, lastAttemptRefusalWithheld: true`) rather than served, and a refusal's
free-text detail, which can name tables and figures, cannot reach the body whoever wrote it. `formatRefusalReasons` de-duplicates and cuts on a whole-code boundary at the
column's 500-character bound, because cutting a code in half would fail the regex and make the
release itself throw.

## Alternatives considered

- **Keep the superuser and document it (ADR-0453's position).**
  - **Pros:** No new role, no new step, works for all three surfaces including `DROP SCHEMA`.
  - **Cons:** A superuser credential in the internet-facing process for every deployment that runs a
    deletion. That is the widest credential the stack has, in the place most likely to be
    compromised.
  - **Why not:** The grant set turned out to be small and derivable from the catalog, so the narrower
    role costs one idempotent script. The superuser is still accepted, and warned about rather than
    refused, because refusing it would break ADR-0453's documented configuration on upgrade.

- **A separate deletion worker process holding the credential.**
  - **Pros:** The credential would leave the internet-facing process entirely, which is strictly
    stronger than narrowing it.
  - **Cons:** It needs a second long-running service, an IPC or queue boundary between the route that
    verifies a request and the process that executes it, and a deployment shape the compose file
    does not have. The runner already executes asynchronously from the database, so the split is
    available; it is just not small.
  - **Why not:** Not now. It composes with this decision rather than replacing it: the worker would
    connect as `crossengin_eraser`. Recorded as an open question.

- **Give the eraser membership in the owner so it can `DROP SCHEMA` per-tenant schemas.**
  - **Pros:** All three surfaces would complete.
  - **Cons:** The owner is the superuser in the image, so membership means `SET ROLE` to superuser.
    PG 16's `WITH SET FALSE` would remove that, but it hands over *ownership-equivalent* privileges on
    every `meta` table, which includes dropping the catalog.
  - **Why not:** Per-tenant schemas exist only with `--store pg-columns --per-tenant-manifests`, which
    already requires the API to run as the owner. The boot line names the undroppable schemas instead.

- **Grant through default privileges at all** (`DELETE`, or the `SELECT` the first draft granted).
  - **Pros:** A new table would be erasable, or at least readable, without a re-run.
  - **Cons:** Default privileges cannot see a table's future fence, and `BYPASSRLS` means a grant is
    the whole of the protection: a default `DELETE` would let the role empty a table later fenced
    because it must outlive its tenant, and a default `SELECT` gave it every `meta` table's rows,
    `meta.users` included.
  - **Why not:** The probe names a missing grant at boot and before the first `DELETE`, and the
    refusal is retryable, so an ungranted new table costs one release until the next `up`.

- **Refuse only membership in a superuser role.**
  - **Pros:** Narrower check, the one the original task asked about.
  - **Cons:** Measured live: `GRANT pg_write_all_data TO crossengin_eraser` passed it and gave the
    role `DELETE` on the fenced trail, which `BYPASSRLS` stops the fence refusing.
  - **Why not:** The role needs no membership at all, so refusing all of them costs nothing.

- **Order released requests strictly after fresh ones, as ADR-0453 did.**
  - **Pros:** A fresh request is never delayed by a retry.
  - **Cons:** It is the starvation in question 2.
  - **Why not:** The backoff is what protects fresh requests from a hot retry loop. Once it has
    elapsed, deadline order is the regulator's order.

- **Configure the backoff by CLI flag.**
  - **Why not:** The store option exists with defaults. Nothing has asked for a different schedule,
    and every flag is a surface that must be fenced.

## What was verified

Offline, plus the role script against a throwaway PG 16 cluster (see *Review corrections*). The
server was not started: this slice ran beside four others in one working tree.

- `@crossengin/tenant-lifecycle`: 83 tests, including both halves required together, the refusal
  requirement, and a reclaimed `in_progress` row whose `inProgressAt` follows its `retryNotBefore`
  parsing.
- `@crossengin/kernel`: 978 tests. The meta-schema test asserts both columns' type, nullability, the
  absence of a default, and `release_count`'s CHECK.
- `@crossengin/tenant-lifecycle-pg`: 577 tests after the review fixes, including:
  - the backoff doubling to a stored `[3, …T00:09:00.000Z, 2]`;
  - the cap, and a custom policy;
  - an inverted policy refused at construction, and non-code reasons refused at release;
  - the claim's SQL in both the grace and the no-grace form;
  - `table_privilege_missing` raised for a missing `DELETE` and not for a statutory table, and for a
    missing pipeline `INSERT` before any `DELETE`;
  - the backoff capped at the grace gate's yield point, and the no-grace claim bound to the store's
    clock;
  - `formatRefusalReasons` cutting on a code boundary;
  - every retry line matching `RELEASE_REASONS_RE`.
- `apps/operate-server`:
  - `deletion-owner-connection`: 25 tests, covering all four postures (`broader` included), the four
    outcomes, an undroppable schema (and a non-tenant-shaped name ignored), the structural
    future-schema answer, a missing grant and a missing pipeline `INSERT`.
  - `tenant-erasure-routes`: 30 tests, including both routes answering `503 schema_not_droppable`
    and recording nothing.
  - `deletion-request-routes`: 116 tests, including the read route returning the three retry fields
    and withholding a refusal that is not a codes list.
  - `deployment-defaults`: 109 tests. Eight fences cover the eraser service, its ordering, its
    environment-only password, the opt-in `.env.example` lines, the attributes and the
    membership refusal in both directions, the recomputed grants with no `UPDATE` and no default
    privilege, the named grants kept in step with `STATUTORY_RETENTION_TABLES` and
    `DELETION_PIPELINE_PRIVILEGES`, role retirement, and the owner opt-out.
  - Typecheck clean.
- `@crossengin/testing`'s workspace rules: 909 tests, after renaming one local so
  `pg-record-reads.ts` reads `schemaName` from `schema_name` as agreement rather than as a divergence.

### Review corrections, verified live on PG 16

A review of the first commit found nine defects; eight were fixed and are folded into the sections
above (the dedicated definition, the per-tenant structural check and route refusal, the backoff's
deadline cap, the store clock, the narrowed grants, the read-side withholding, the pipeline-wide
privilege check, and role retirement), and the orphaned `formatRefusalReasons` doc comment was moved
back above its function. One was partly refuted: the claim that the no-grace claim and the release
used different clocks was true of the store's SQL and unreachable from the live runner, which always
passes a grace gate computed from its own clock on both sides — fixed anyway, since a caller passing
no grace is legitimate.

The role script was run against a throwaway PG 16.15 cluster carrying a seeded `meta` schema (a
target, a fenced table, the two statutory tables, the three append tables, `meta.users`, a boot
table): provisioned, re-run idempotently, the readback read `superuser=f bypassrls=t memberships=0`,
`UPDATE on 0`, `DELETE on 0 fenced`, `INSERT on 3 of 3`, and `information_schema.role_table_grants`
held exactly the derived set with nothing on `meta.users`. Each refusal fired by name with exit 3 and
before any role was altered: a membership in `pg_write_all_data`, a membership in a `SUPERUSER`
role, and the app role made a member of the eraser. Renaming `DELETION_PGUSER` retired the old role
(`NOLOGIN`, no `BYPASSRLS`, zero table grants, marker `…:retired`) and provisioned the new one;
unsetting it retired that one with a `NOTICE`; a second unset run changed nothing; and naming the
first again re-adopted it as `LOGIN BYPASSRLS`. A real deletion run as `crossengin_eraser` is still
not exercised.

## Open questions

1. **A separate deletion worker process.** It would take the credential out of the internet-facing
   process. See Alternatives.
2. **Per-tenant schemas are not droppable by the eraser.** The boot line says so structurally and
   the schema-erasure routes refuse `503 schema_not_droppable` before acting, but a pipeline deletion
   that reaches one still rolls back and stays `in_progress` for reconciliation. It is not released,
   because the cause is raised after the shared erasure has run, which is ADR-0453's open question 1;
   asking `tenantSchemaDroppable` before the first `DELETE` would make it a retryable refusal.
3. **The boot schema is recognised by its policy name.** A boot schema moved off `public` with
   `--schema` is not granted by the script. Its tables carry the same policy, so extending the
   `public` clause to the configured schema is one variable once the compose file passes it.
4. **Granting `BYPASSRLS` needs a superuser runner.** On a managed provider whose admin role is not a
   superuser, the `ALTER ROLE` is refused. That is the correct refusal, and on such a provider the
   owner path is not a superuser either, so ADR-0453's warning does not apply there.
5. **The backoff's defaults are not configurable from the CLI.** The store option exists.
6. ~~**A real deletion as `crossengin_eraser` is not verified live.**~~ Closed by the "Verified
   live" section below: a deletion as the eraser completed on both stores with `verify-chain` exit 0,
   after the run found and fixed the six targets the grant set had missed.
7. **`last_attempt_refusal` carries no CHECK.** The codes shape is enforced at the release writer
   and again on read; a column `CHECK (last_attempt_refusal ~ '…')` would make it a property of the
   table, at the cost of standing manual SQL on every deployment holding a reject-path row that does
   not match (ADR-0363 reports such a row rather than planning the constraint).
8. **A retired role is not dropped.** It holds nothing and cannot log in, but it stays in
   `pg_roles`; dropping it is an operator's act.

## Verified live

PG 16, compose order run by hand (`migrate` → `app-role` → `eraser-role` → `document-indexes`), the API
from `apps/operate-server/dist` as `crossengin_app` with the deletion routes, the runner every 3 s and
six `--deletion-capability` lines. Full record: the slice's `live-eraser.md`.

**A defect in this decision, found by the first boot and fixed.** Section 1's premise — "the fenced set
is the Article 17 retention union (ADR-0401)" — is false in this tree: the catalog fences **24** tables,
the 18 retained ones and six it fences against a *tenant* delete although the erasure empties them
(`tenantUndeletableRecord`: `crypto_audit`, `dr_drill_executions`, `dr_failover_executions`,
`dr_readiness_snapshots`, `notification_suppressions`, `slo_enforcement_actions`), with a byte-identical
policy. The script therefore granted `DELETE` on 91 tables, and every deletion as `crossengin_eraser` was
refused `table_privilege_missing` naming 12 missing grants. Fixed: the script grants the six by name
(kept equal to `TENANT_UNDELETABLE_TABLES` in both directions by `deployment-defaults.test.ts`), and the
posture probe counts `DELETE` on the **retention union** (`RETAINED_SHARED_TABLES`, passed as `$1`)
rather than on any fenced table, which otherwise read the correctly granted role as
`broader … may DELETE from 6 fenced table(s)`. Readback after the fix:
`SELECT on 101 and DELETE on 97 meta tables, DELETE on 0 retained, UPDATE on 0; INSERT on 3 of 3`. The
probe fix was run from source against the live database (the dist was not rebuilt), answering
`info … a dedicated role, every one of its 99 target tables is present, scoped, granted and unconfined`.

Measured, after the fix:

- **A real deletion as `crossengin_eraser`** (closes open question 6): `--store pg`, request `completed`,
  tenant `deleted`, records and memberships 0, tombstone v4 anchored at chain sequence 12,
  `verify-chain` exit 0; `--store pg-columns` (51 boot-schema tables granted), `public.vendor` 3 → 0,
  tombstone `{"model":"typed_tables","schema":"public","relationCount":51}`, `verify-chain` exit 0. As the
  eraser: `DELETE FROM meta.audit_log`, `UPDATE meta.tenants`, `DELETE FROM meta.tenant_tombstones` and a
  read of `meta.users` are each `permission denied`; `is_superuser` off.
- **Superuser and membership**: `DELETION_PGUSER=crossengin` retires the marked eraser (NOLOGIN, no
  BYPASSRLS, 0 grants) and the boot line warns *a SUPERUSER*. `GRANT crossengin TO crossengin_eraser`
  makes the step exit 3 naming the membership; the API booted anyway warns *a member of a SUPERUSER role,
  which it can SET ROLE to*, and as that role `is_superuser` is `off` until `SET ROLE crossengin`, then
  `on`.
- **Refusals**: placeholder, a 12-character password, the owner's password, the app role's password,
  `DELETION_PGUSER=crossengin_app` and `crossengin_app` made a member of the eraser each exit 3 by name;
  the eraser's password hash is unchanged by every one. The app-role-name run retires the previously
  provisioned eraser before refusing.
- **Missing grant and backoff**: with `DELETE` revoked on `meta.operate_entity_records`, a deletion is
  released `erase/table_privilege_missing`, `release_count 1`, `retry_not_before` = claim + 60.013 s,
  tenant still `pending_deletion`, no rows deleted; the read route returns all three fields. No claim for
  ≈20 ticks, reclaim 37 ms after `retry_not_before`, second release + 120 s; after the step restored the
  grant the next claim completed.
- **Deadline order** (`dueForExecution`, limit 1): a released request with an older deadline and an
  elapsed backoff is claimed ahead of a fresh one; with its backoff pending the fresh one is claimed.
- **Later tables**: a catalogued table recreated by `migrate` is ungranted (no default privilege), the
  probe names both missing grants, and a step re-run grants them; a restrictive `DELETE` fence added to a
  table revokes its grant on the next run. An uncatalogued table is not an erasure target and is not
  named by the probe.
- **Per-tenant schema** (a hand-made owner schema on `--store pg`): the line names it undroppable and does
  not say every deletion will be refused; the deletion aborts `permission denied for schema …` and stays
  `in_progress` with the data intact (open question 2, unchanged).
- **Reason codes**: a release carrying free text is refused `contract_violated`; a free-text value written
  by hand reads back `lastAttemptRefusal: null, lastAttemptRefusalWithheld: true` on the read and pending
  routes.
- **Migration**: with both columns dropped from a populated table, `crossengin-pg apply --plan` plans two
  `add_column` steps, 0 unreconciled; applied, the re-plan is clean and the CHECK is present.

Not run: `docker compose` itself, and a per-tenant schema created through `--per-tenant-manifests`.

## Addendum: two things the live run found after its own fixes

- **A refused run retired the role it was refusing to change.** The retirement block ran ahead of the
  refusals, so `DELETION_PGUSER=crossengin_app` (refused) first set the provisioned
  `crossengin_eraser` to `NOLOGIN NOBYPASSRLS` and revoked its grants, which would stop every deletion
  on a deployment that only mistyped a variable. The refusals now run first, skipped only when no role
  is being provisioned (unset, or naming the owner), and the retirement after them. Re-measured on
  PG 16: after provisioning, a run naming the app role and a run with a 5-character password each exit
  3 with the role still `LOGIN BYPASSRLS` and its marker unchanged; an unset run then retires it, and a
  run naming it again re-adopts it.
- **The remedy named the role the operator was already using.** When the deletion credential is
  `crossengin_eraser` and holds a superuser membership granted by hand, the boot line told the operator
  to use the dedicated `crossengin_eraser` role. It now tells them to re-run the `eraser-role` step,
  which refuses while the membership exists and names what to `REVOKE`; the original sentence is kept
  for a credential that is some other role.
