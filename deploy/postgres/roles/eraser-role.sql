-- The role the Article 17 deletion pipeline connects as (ADR-0458): LOGIN, NOSUPERUSER, BYPASSRLS,
-- owning nothing, a member of no role, and holding exactly the privileges the pipeline's statements
-- use.
--
-- Why it exists. An erasure empties tables the app role's policies confine, so it cannot run as
-- the app role (ADR-0453), and the only other role the stack had was POSTGRES_USER — a SUPERUSER in
-- the official image. A superuser credential in the internet-facing `api` process makes a compromise
-- of that process the whole database server (COPY ... TO PROGRAM included). This role is the
-- narrower answer: BYPASSRLS is the one attribute the erasure needs, because its probe refuses a
-- session row-level security confines (ADR-0329), and nothing more is held.
--
-- BYPASSRLS takes the restrictive `FOR DELETE USING (false)` fences out of play for this role, so the
-- absence of a grant is the only protection the retained tables have against it. That is why every
-- grant below is derived from what the pipeline issues and nothing is inherited: the script refuses
-- any role membership in either direction, and the API's `[deletion]` line reports a role holding a
-- membership, an owned table, an UPDATE or a DELETE on a retained table as broader than it needs.
--
-- What it can do, measured against the pipeline (ADR-0458; `DELETION_PIPELINE_PRIVILEGES` in
-- packages/tenant-lifecycle-pg is the list the API asks about at boot and before the first DELETE):
--   * SELECT + DELETE on the erasure's targets: every `meta` table carrying a `tenant_id` column and
--     no restrictive `FOR DELETE USING (false)` policy, plus the six the catalog fences against a
--     *tenant* delete although the erasure empties them (`tenantUndeletableRecord`, named below).
--     Every retained table carries the fence (ADR-0400, ADR-0401), but the fence is no longer only
--     the retained set, so "unfenced" alone missed six targets and every deletion was refused
--     `table_privilege_missing` (measured live, ADR-0458). SELECT because each DELETE returns the
--     row's size and the confirm pass counts what is left.
--   * SELECT on the two statutory tables the erasure reads for its retention claim and never deletes
--     from (`STATUTORY_RETENTION_TABLES`).
--   * SELECT on `meta.tenants` (the tenant's state before the transition) and on
--     `meta.forensic_chain_entries` (the chain's tail the tombstone's entry links to).
--   * INSERT on the three tables the pipeline appends to: the tombstone, its chain entry and the
--     lifecycle event. None has RETURNING, ON CONFLICT or a sequence default.
--   * SELECT + DELETE on the boot schema's entity tables.
-- Nothing else: no UPDATE anywhere (the request's transition and the tenant row's move stay on the app
-- role's connection), no read of `meta.users`, of other tables' rows or of any table created later.
--
-- What it deliberately cannot do: DROP a per-tenant `t_<hex>` schema. That needs ownership of the
-- schema, i.e. membership in the role that created it, and membership is refused here. A deployment
-- with per-tenant schemas runs its deletions as their owner; the `[deletion]` boot line says so, and
-- the schema-erasure route answers `schema_not_droppable`.
--
-- Run by the one-shot `eraser-role` service on EVERY `up`, after `migrate`, as POSTGRES_USER. Every
-- statement is idempotent and the grants are recomputed from the catalog inside one transaction, so
-- a re-run converges: a table `migrate` added since the last run is granted (a new table gets nothing
-- until then — the API names the missing grant at boot and refuses a deletion
-- `table_privilege_missing` before destroying anything, and that refusal is released for a retry),
-- a table the catalog has since fenced loses its DELETE, and the password follows the env var.
--
-- Opt-in, like DELETION_PGUSER itself: empty means no role is provisioned. A role this step
-- provisioned earlier carries a marker comment, so unsetting or renaming DELETION_PGUSER retires it
-- (NOLOGIN NOBYPASSRLS, every grant and default privilege revoked) rather than leaving a live BYPASSRLS
-- credential behind. The name and password come from the environment through \getenv, never from argv
-- (ADR-0301).
\set ON_ERROR_STOP on

\getenv eraser_user CROSSENGIN_ERASER_DB_USER
\getenv eraser_password CROSSENGIN_ERASER_DB_PASSWORD
\getenv app_user CROSSENGIN_APP_DB_USER
\getenv app_password CROSSENGIN_APP_DB_PASSWORD
\getenv owner_password PGPASSWORD
\if :{?eraser_user}
\else
  \set eraser_user ''
\endif
\if :{?eraser_password}
\else
  \set eraser_password ''
\endif
\if :{?app_user}
\else
  \set app_user ''
\endif
\if :{?app_password}
\else
  \set app_password ''
\endif
\if :{?owner_password}
\else
  \set owner_password ''
\endif
\set marker 'crossengin:eraser-role'

-- The refusals run before anything is touched, the retirement included: a refused run must leave
-- every role exactly as it found it (measured live, ADR-0458: a refused DELETION_PGUSER naming the
-- app role used to retire the provisioned eraser first). They are skipped when no role is being
-- provisioned (DELETION_PGUSER unset, or naming the owner), where there is nothing to refuse.
SELECT (:'eraser_user' = '' OR :'eraser_user' = current_user) AS provisioning_skipped \gset
\if :provisioning_skipped
\else
-- Refusals, before any role is touched. Each raises through \gexec, so a refusal is one named
-- sentence and a non-zero exit, and `api` (which waits on this service) never starts.
SELECT format('DO $r$ BEGIN RAISE EXCEPTION %L; END $r$', refusal)
  FROM (
    SELECT CASE
      -- One role for both would give the internet-facing request path BYPASSRLS on every query.
      WHEN :'eraser_user' = :'app_user' THEN
        'eraser-role: DELETION_PGUSER names the app role ' || :'app_user'
        || '; the deletion role must be its own role (crossengin_eraser is the shipped name)'
      WHEN :'eraser_password' = '' THEN
        'eraser-role: DELETION_PGPASSWORD is empty; set it in deploy/.env (openssl rand -hex 24)'
      WHEN starts_with(:'eraser_password', 'REPLACE_WITH_') THEN
        'eraser-role: DELETION_PGPASSWORD still holds the .env.example placeholder, which is published in this repository; '
        || 'replace it (openssl rand -hex 24)'
      WHEN length(:'eraser_password') < 16 THEN
        'eraser-role: DELETION_PGPASSWORD is shorter than 16 characters; use openssl rand -hex 24'
      -- One leaked secret must not open two roles.
      WHEN :'owner_password' <> '' AND :'eraser_password' = :'owner_password' THEN
        'eraser-role: DELETION_PGPASSWORD equals POSTGRES_PASSWORD; give the deletion role its own password'
      WHEN :'app_password' <> '' AND :'eraser_password' = :'app_password' THEN
        'eraser-role: DELETION_PGPASSWORD equals POSTGRES_APP_PASSWORD; give the deletion role its own password'
      -- Any membership at all. A member of a SUPERUSER role can SET ROLE to it; a member of the app
      -- role inherits UPDATE on every meta table; a member of pg_write_all_data inherits DELETE on the
      -- fenced trail, which BYPASSRLS stops the fence from refusing; pg_execute_server_program is COPY
      -- TO PROGRAM. Asked of pg_auth_members, which a superuser attribute cannot answer for, so it is
      -- right whatever the role's attributes are now.
      WHEN EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles e ON e.oid = m.member
                    WHERE e.rolname = :'eraser_user') THEN
        'eraser-role: ' || :'eraser_user' || ' is a member of '
        || (SELECT string_agg(g.rolname, ', ' ORDER BY g.rolname)
              FROM pg_auth_members m JOIN pg_roles e ON e.oid = m.member JOIN pg_roles g ON g.oid = m.roleid
             WHERE e.rolname = :'eraser_user')
        || '; the deletion role holds no membership, since BYPASSRLS leaves the absence of a grant as '
        || 'the only fence the retained tables have against it -- REVOKE it'
      -- The other direction: anyone who can SET ROLE to the eraser holds BYPASSRLS.
      WHEN EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles e ON e.oid = m.roleid
                    WHERE e.rolname = :'eraser_user') THEN
        'eraser-role: '
        || (SELECT string_agg(g.rolname, ', ' ORDER BY g.rolname)
              FROM pg_auth_members m JOIN pg_roles e ON e.oid = m.roleid JOIN pg_roles g ON g.oid = m.member
             WHERE e.rolname = :'eraser_user')
        || ' is a member of ' || :'eraser_user'
        || ', so it could SET ROLE past row-level security; REVOKE that membership'
      WHEN EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('meta', 'public')
           AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = :'eraser_user')
      ) THEN
        'eraser-role: ' || :'eraser_user' || ' owns a table in schema meta or public; '
        || 'ALTER TABLE ... OWNER TO ' || current_user || ' first'
      WHEN to_regnamespace('meta') IS NULL THEN
        'eraser-role: schema meta does not exist -- this runs after migrate; did migrate succeed?'
    END AS refusal
  ) r
 WHERE refusal IS NOT NULL
\gexec
\endif

-- Retire a role this step provisioned under a name DELETION_PGUSER no longer gives (unset, renamed,
-- or pointed at the owner). Retired rather than dropped: DROP ROLE is irreversible and the role may
-- own something an operator gave it by hand, while NOLOGIN NOBYPASSRLS plus the revokes leave it
-- unable to connect and holding nothing this step granted. The marker moves to `…:retired`, so a
-- retired role is not retired again on every `up`, and a later DELETION_PGUSER naming it adopts it.
SELECT stmt
  FROM pg_roles r
  CROSS JOIN LATERAL unnest(ARRAY[
    format('ALTER ROLE %I WITH NOLOGIN%s', r.rolname,
           CASE WHEN r.rolbypassrls THEN ' NOBYPASSRLS' ELSE '' END),
    format('REVOKE ALL ON DATABASE %I FROM %I', current_database(), r.rolname),
    format('REVOKE ALL ON SCHEMA public FROM %I', r.rolname),
    format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r.rolname)
  ] || CASE WHEN to_regnamespace('meta') IS NULL THEN ARRAY[]::text[] ELSE ARRAY[
    format('REVOKE ALL ON SCHEMA meta FROM %I', r.rolname),
    format('REVOKE ALL ON ALL TABLES IN SCHEMA meta FROM %I', r.rolname),
    format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA meta FROM %I', r.rolname),
    format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA meta REVOKE ALL ON TABLES FROM %I',
           current_user, r.rolname)
  ] END || ARRAY[
    format('COMMENT ON ROLE %I IS %L', r.rolname, :'marker' || ':retired'),
    -- \gexec runs SQL, not psql meta-commands, so the report is a NOTICE rather than an \echo.
    format('DO $r$ BEGIN RAISE NOTICE %L; END $r$', 'eraser-role: retired ' || r.rolname
      || ' (NOLOGIN NOBYPASSRLS, every grant revoked), which this step provisioned and DELETION_PGUSER no longer names')
  ]) AS stmt
 WHERE shobj_description(r.oid, 'pg_authid') = :'marker'
   AND r.rolname <> :'eraser_user'
   AND r.rolname <> current_user
\gexec

SELECT (:'eraser_user' = '') AS eraser_unset \gset
\if :eraser_unset
  \echo 'eraser-role: DELETION_PGUSER is unset, so no deletion role is provisioned. Only the Article 17 deletion surfaces use it; deploy/README.md, "The database roles".'
  \quit
\endif

-- The ADR-0453 configuration: the deletion pipeline connects as the catalog owner. Kept working on
-- upgrade rather than refused, because it is a choice an operator may have made deliberately; the
-- API's own `[deletion]` boot line names it a SUPERUSER and its cost on every start.
SELECT (:'eraser_user' = current_user) AS eraser_is_owner \gset
\if :eraser_is_owner
  \echo 'eraser-role: DELETION_PGUSER names POSTGRES_USER, a SUPERUSER in the official image; nothing was created. A dedicated crossengin_eraser role is narrower (deploy/README.md, "The database roles").'
  \quit
\endif

SELECT format('CREATE ROLE %I LOGIN', :'eraser_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'eraser_user')
\gexec

-- Re-asserted on every run. An attribute is named only when it must change, because Postgres
-- refuses NOSUPERUSER / NOREPLICATION / BYPASSRLS from a runner lacking that attribute even when it
-- changes nothing. Granting BYPASSRLS needs a superuser runner, which POSTGRES_USER is in the
-- official image; on a managed provider whose admin role is not one, this is the refusal it should
-- be, and README.md says what to do instead.
SELECT format(
  'ALTER ROLE %I WITH LOGIN NOCREATEDB NOCREATEROLE%s%s%s PASSWORD %L',
  r.rolname,
  CASE WHEN r.rolsuper THEN ' NOSUPERUSER' ELSE '' END,
  CASE WHEN r.rolreplication THEN ' NOREPLICATION' ELSE '' END,
  CASE WHEN r.rolbypassrls THEN '' ELSE ' BYPASSRLS' END,
  :'eraser_password')
  FROM pg_roles r WHERE r.rolname = :'eraser_user'
\gexec

-- The marker that lets a later run retire this role if DELETION_PGUSER stops naming it.
SELECT format('COMMENT ON ROLE %I IS %L', :'eraser_user', :'marker') \gexec

-- The grants are recomputed rather than accumulated, so a table the catalog fenced since the last run
-- loses its DELETE. One transaction, so a deletion running during `up` never sees the window between
-- the REVOKE and the GRANT.
BEGIN;
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'eraser_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA meta, public TO %I', :'eraser_user') \gexec
SELECT format('REVOKE ALL ON ALL TABLES IN SCHEMA meta FROM %I', :'eraser_user') \gexec
SELECT format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', :'eraser_user') \gexec
SELECT format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA meta FROM %I', :'eraser_user') \gexec
-- An earlier version of this step granted SELECT on every future meta table by default; nothing does
-- now, so a new table is ungranted until this step re-derives it.
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA meta REVOKE ALL ON TABLES FROM %I',
              current_user, :'eraser_user') \gexec

-- The erasure's targets, derived from the catalog: every `meta` table carrying a `tenant_id` column,
-- minus the ones fenced against a tenant delete. The fence covers the Article 17 retention union
-- (ADR-0401) and also the tables a tenant must not delete although the erasure does empty them, so
-- those are granted by name in the next statement.
SELECT format('GRANT SELECT, DELETE ON %I.%I TO %I', n.nspname, c.relname, :'eraser_user')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'meta' AND c.relkind IN ('r', 'p') AND c.relname <> '_meta_migrations'
   AND EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
   AND NOT EXISTS (SELECT 1 FROM pg_policy p
                    WHERE p.polrelid = c.oid AND p.polcmd = 'd' AND NOT p.polpermissive
                      AND pg_get_expr(p.polqual, p.polrelid) = 'false')
\gexec

-- The erasure targets the catalog fences with `tenantUndeletableRecord`: undeletable by a tenant, and
-- still the tenant's to erase. Named rather than derived, because their fence is byte-identical to a
-- retained table's, and the failure of a missing name is the safe one (the API names the missing
-- grant and refuses the deletion before any DELETE). Kept in step with `TENANT_UNDELETABLE_TABLES`
-- by deployment-defaults.test.ts, in both directions.
SELECT format('GRANT SELECT, DELETE ON %s TO %I', t, :'eraser_user')
  FROM unnest(ARRAY['meta.crypto_audit', 'meta.dr_drill_executions', 'meta.dr_failover_executions',
                    'meta.dr_readiness_snapshots', 'meta.notification_suppressions',
                    'meta.slo_enforcement_actions']) AS t
 WHERE to_regclass(t) IS NOT NULL
\gexec

-- What the rest of the pipeline reads: the statutory tables (the retention claim), the tenant's state
-- and the chain's tail. Kept in step with `STATUTORY_RETENTION_TABLES` and
-- `DELETION_PIPELINE_PRIVILEGES` by deployment-defaults.test.ts, in both directions.
SELECT format('GRANT SELECT ON %s TO %I', t, :'eraser_user')
  FROM unnest(ARRAY['meta.invoices', 'meta.tenant_credits', 'meta.tenants', 'meta.forensic_chain_entries']) AS t
 WHERE to_regclass(t) IS NOT NULL
\gexec

-- What the pipeline appends: the tombstone, the chain entry anchoring it, and the lifecycle event.
SELECT format('GRANT INSERT ON %s TO %I', t, :'eraser_user')
  FROM unnest(ARRAY['meta.tenant_tombstones', 'meta.forensic_chain_entries', 'meta.tenant_lifecycle_events']) AS t
 WHERE to_regclass(t) IS NOT NULL
\gexec

-- The boot manifest's own entity tables (ADR-0350), recognised by the policy the column-store emitter
-- writes on every one of them and nothing else writes — `censusBootSchemaTables`' signature.
SELECT format('GRANT SELECT, DELETE ON %I.%I TO %I', n.nspname, c.relname, :'eraser_user')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
   AND EXISTS (SELECT 1 FROM pg_policy p
                WHERE p.polrelid = c.oid AND p.polname = c.relname || '_tenant_isolation')
\gexec
COMMIT;

-- The result, read back from the catalog rather than asserted: what the API's `[deletion]` line
-- will say about this role.
SELECT format(
  'eraser-role: %s is ready -- superuser=%s bypassrls=%s memberships=%s; SELECT on %s and DELETE on %s meta tables, DELETE on %s retained, UPDATE on %s; DELETE on %s boot-schema tables; INSERT on %s of 3 append tables; owns %s tables',
  r.rolname, r.rolsuper, r.rolbypassrls,
  (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid),
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'meta' AND c.relkind IN ('r', 'p') AND has_table_privilege(r.oid, c.oid, 'SELECT')),
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'meta' AND c.relkind IN ('r', 'p') AND has_table_privilege(r.oid, c.oid, 'DELETE')),
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'meta' AND c.relkind IN ('r', 'p') AND has_table_privilege(r.oid, c.oid, 'DELETE')
      AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polcmd = 'd' AND NOT p.polpermissive
                   AND pg_get_expr(p.polqual, p.polrelid) = 'false')
      AND c.relname <> ALL (ARRAY['crypto_audit', 'dr_drill_executions', 'dr_failover_executions',
                                  'dr_readiness_snapshots', 'notification_suppressions', 'slo_enforcement_actions'])),
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'meta' AND c.relkind IN ('r', 'p') AND has_table_privilege(r.oid, c.oid, 'UPDATE')),
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND has_table_privilege(r.oid, c.oid, 'DELETE')),
  (SELECT count(*) FROM unnest(ARRAY['meta.tenant_tombstones', 'meta.forensic_chain_entries', 'meta.tenant_lifecycle_events']) t
    WHERE to_regclass(t) IS NOT NULL AND has_table_privilege(r.oid, to_regclass(t), 'INSERT')),
  (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid AND c.relkind IN ('r', 'p'))) AS eraser_role
  FROM pg_roles r WHERE r.rolname = :'eraser_user';
