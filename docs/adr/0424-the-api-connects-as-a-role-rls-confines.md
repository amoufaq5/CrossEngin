# ADR-0424: The API connects as a role row-level security confines

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0362 (`row_security_active`), ADR-0389 (the job queue was owner-dependent), ADR-0400 / ADR-0401 (the DELETE fences, inert for an owner), ADR-0423 (the owner-run index step), ADR-0338 (an upgraded deployment must keep working) |

## Context

**H-01**: the shipped compose connected the API as `POSTGRES_USER`, the role that ran `migrate` —
the owner of every table and a superuser. An owner bypasses RLS, so every isolation policy, every
platform split (ADR-0332) and every DELETE fence (ADR-0400) was inert on the deployment that ships.
Tenant isolation still held because the stores carry explicit `tenant_id` predicates, but the
database's own belt was off.

## Decision

A one-shot `app-role` service runs `deploy/postgres/roles/app-role.sql` after `migrate`, and `api`
waits on both: it creates (or converges) `crossengin_app` as `NOSUPERUSER NOBYPASSRLS NOREPLICATION`,
owning nothing, with DML on every `meta` table. The API connects as it. At boot
`serving-role-survey.ts` asks Postgres (`row_security_active`, ADR-0362) and prints
`[pg] row-level security: role crossengin_app is confined on all 115 policied table(s)`, or names the
tables it bypasses and why. On `--store pg-columns` it surveys the column-store schema too, because
that store's tables are created by the serving role, which therefore owns them.

The script refuses (exit 3) an empty, placeholder or short password, an empty user, a password
**equal to the owner's**, and — checked again after `ALTER ROLE` — a role still a member of the
owner, which review found would otherwise be reported ready while bypassing every policy.

**The upgrade lands on the opt-out, not on a refusal.** An upgraded `.env` has no
`POSTGRES_APP_USER` / `POSTGRES_APP_PASSWORD`, and refusing would take a running deployment down on
`up`. So the compose defaults both to the owner's (`${POSTGRES_APP_USER:-${POSTGRES_USER}}`), the
script accepts the owner as an explicit opt-out, and the boot line says the API bypasses RLS. Setting
the two lines in `.env` is what moves a deployment onto the confined role. The half-configured case
(user unset, a password set) is refused, because the password then equals neither the owner's
deliberately nor an app role's.

Owner-only work stays with the owner: `migrate`, `app-role`, and ADR-0423's `document-indexes`.

## Alternatives considered

- **Refuse when the new variables are absent.** Measured as an outage on upgrade; ADR-0338.
- **`FORCE ROW LEVEL SECURITY` on the owner.** Refuted in ADR-0401: a superuser or `BYPASSRLS`
  owner defeats it, and the shipped owner is both.

## Consequences

The job fleet and workflow engine are not confined-ready (`job_runs`, `workflow_timers`,
`workflow_activities` carry tenant isolation only), so `--workflow-workers` as the app role reports
the queue not visible — neither flag is on the shipped command, and the README says so.
`pg_dump` as the app role stops at the first policied table; backups run as the owner.

## Implementation notes

Verified live on PG 16 in compose order: arm A (half-configured) refuses with exit 3; arm B (opt-out)
exits 0; arm C reports `superuser=f bypassrls=f; DML on 146 of 146` and the API boots `confined on
all 115`. The full bootstrap, entity CRUD, an invoice send posting GL, an idempotent replay and the
checkpoint and integrity passes all run as the app role with no `42501`.

## Open questions

1. Per-tenant `t_<hex>` schemas on `pg-columns` are created after boot and not surveyed.
2. Untested against a real Supabase project (`public.unaccent` reachability from schema
   `extensions`).
3. The password has a length floor, not an entropy floor.

## References

- `deploy/postgres/roles/app-role.sql`, `deploy/docker-compose.yml`, `deploy/README.md`
  ("The database roles"); `apps/operate-server/src/serving-role-survey.ts`
