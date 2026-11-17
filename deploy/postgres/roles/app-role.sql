-- The role the API connects as: LOGIN, NOSUPERUSER, NOBYPASSRLS, owning nothing, holding DML on
-- the catalog `migrate` created and nothing else.
--
-- Why it exists. The stack used to connect the API as POSTGRES_USER, which the official image makes
-- a superuser that also holds BYPASSRLS and owns every table `migrate` creates — any one of the
-- three makes every row-level-security policy inert for that session. Tenant isolation then rested
-- on the stores' own `tenant_id` predicates alone. They hold, measured; the policies are the second
-- belt, and a second belt that no statement consults is a declaration and not a control.
--
-- Run by the one-shot `app-role` service on EVERY `up`, after `migrate`, as POSTGRES_USER — never
-- from /docker-entrypoint-initdb.d, which runs only on a volume's first initialisation and runs
-- before the `meta` schema exists. Every statement is idempotent, so a re-run converges: the
-- password follows the env var (rotate by changing it and re-running `up`), the attributes are
-- re-asserted, and every table `migrate` added since the last run is granted.
--
-- The name and password come from the environment through \getenv, never from argv (ADR-0301): a
-- compose `command:` is readable by anyone who can run `ps` on the host.
\set ON_ERROR_STOP on

\getenv app_user CROSSENGIN_APP_DB_USER
\getenv app_password CROSSENGIN_APP_DB_PASSWORD
\getenv owner_password PGPASSWORD
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

-- Refusals first, before any role is touched. Each raises through \gexec, so a refusal is one
-- named sentence and a non-zero exit, and `api` (which waits on this service) never starts.
SELECT format('DO $r$ BEGIN RAISE EXCEPTION %L; END $r$', refusal)
  FROM (
    SELECT CASE
      WHEN :'app_user' = '' THEN
        'app-role: POSTGRES_APP_USER is empty -- set it in deploy/.env (crossengin_app is the shipped name)'
      -- POSTGRES_APP_USER = POSTGRES_USER is the declared opt-out handled below the refusals, so
      -- none of the password or role checks applies to it.
      WHEN :'app_user' = current_user THEN NULL
      WHEN :'app_password' = '' THEN
        'app-role: POSTGRES_APP_PASSWORD is empty -- an upgraded deployment gains it here; add the line from deploy/.env.example '
        || '(openssl rand -hex 24) and re-run up, or keep the API on the owner as before by setting POSTGRES_APP_USER and '
        || 'POSTGRES_APP_PASSWORD to the POSTGRES_USER and POSTGRES_PASSWORD values (deploy/README.md, "The database roles")'
      -- Compose falls the password back to the owner's when POSTGRES_APP_PASSWORD is unset, which is
      -- right only for the opt-out above. A named app role holding the owner's password would make
      -- one leaked secret open both roles, so a half-configured .env is refused here instead.
      WHEN :'owner_password' <> '' AND :'app_password' = :'owner_password' THEN
        'app-role: POSTGRES_APP_PASSWORD is unset or equal to POSTGRES_PASSWORD, and ' || :'app_user'
        || ' is not the owner; give it its own password (openssl rand -hex 24), or set POSTGRES_APP_USER '
        || 'to POSTGRES_USER to keep the API on the owner (deploy/README.md, "The database roles")'
      WHEN starts_with(:'app_password', 'REPLACE_WITH_') THEN
        'app-role: POSTGRES_APP_PASSWORD still holds the .env.example placeholder, which is published in this repository; '
        || 'replace it (openssl rand -hex 24)'
      WHEN length(:'app_password') < 16 THEN
        'app-role: POSTGRES_APP_PASSWORD is shorter than 16 characters; use openssl rand -hex 24'
      -- A superuser has every role's privileges, and is about to be altered NOSUPERUSER below, so
      -- only a NON-superuser's membership is the defect here.
      WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user' AND NOT rolsuper)
           AND pg_has_role(:'app_user', current_user, 'USAGE') THEN
        'app-role: ' || :'app_user' || ' is a member of ' || current_user
        || ', so it holds the owner''s privileges and bypasses every policy; revoke that membership'
      WHEN EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'meta' AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = :'app_user')
      ) THEN
        'app-role: ' || :'app_user' || ' owns a table in schema meta, and an owner bypasses its policies; '
        || 'ALTER TABLE ... OWNER TO ' || current_user || ' first'
      WHEN to_regnamespace('meta') IS NULL THEN
        'app-role: schema meta does not exist -- this runs after migrate; did migrate succeed?'
    END AS refusal
  ) r
 WHERE refusal IS NOT NULL
\gexec

-- The opt-out. Naming the owner keeps the API connecting as it, which is the pre-split behaviour:
-- correct answers, every policy inert. Said here and by the API's own boot line on every start,
-- which is the record that the choice was made; nothing is created or granted.
SELECT (:'app_user' = current_user) AS app_is_owner \gset
\if :app_is_owner
  \echo 'app-role: POSTGRES_APP_USER names POSTGRES_USER, so the API connects as the catalog owner and every row-level-security policy is inert for it; nothing was created. deploy/README.md, "The database roles".'
  \quit
\endif

SELECT format('CREATE ROLE %I LOGIN', :'app_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

-- Re-asserted on every run, so a role an operator created by hand is brought to the contract too.
-- An attribute is named only when the role holds it: Postgres refuses NOSUPERUSER / NOREPLICATION
-- (and NOBYPASSRLS) from a runner lacking that attribute even when it changes nothing, and a managed
-- provider's admin role (Supabase's `postgres`) is not a superuser. A role that does hold one then
-- needs a runner entitled to remove it, which is the refusal it should be.
-- %L quotes the password; it reaches this server as a literal in one statement and no log line
-- under the image's default log_statement = none.
SELECT format(
  'ALTER ROLE %I WITH LOGIN NOCREATEDB NOCREATEROLE%s%s%s PASSWORD %L',
  r.rolname,
  CASE WHEN r.rolsuper THEN ' NOSUPERUSER' ELSE '' END,
  CASE WHEN r.rolbypassrls THEN ' NOBYPASSRLS' ELSE '' END,
  CASE WHEN r.rolreplication THEN ' NOREPLICATION' ELSE '' END,
  :'app_password')
  FROM pg_roles r WHERE r.rolname = :'app_user'
\gexec

-- The membership refusal above skips a superuser, because a superuser answers `pg_has_role` true
-- for every role. So a hand-made role that was SUPERUSER *and* a member of the owner reached here,
-- lost the first attribute and kept the second — measured, it then read `row_security_active = f`
-- while this script reported it ready. Asked again now that the answer means membership.
SELECT format('DO $r$ BEGIN RAISE EXCEPTION %L; END $r$',
  'app-role: ' || :'app_user' || ' is a member of ' || current_user
  || ', so it holds the owner''s privileges and bypasses every policy; revoke that membership')
 WHERE pg_has_role(:'app_user', current_user, 'USAGE')
\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA meta, public TO %I', :'app_user') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA meta TO %I', :'app_user') \gexec
SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA meta TO %I', :'app_user') \gexec
-- The applier's own bookkeeping is not the API's: a role that could write it could make the next
-- `apply` skip a statement it believes already ran. Not a catalogued table, so the grant above is
-- the only thing that reached it.
SELECT format('REVOKE ALL ON meta._meta_migrations FROM %I', :'app_user')
 WHERE to_regclass('meta._meta_migrations') IS NOT NULL
\gexec

-- For a table the owner creates between two runs of this step (`docker compose run --rm migrate`).
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA meta GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
  current_user, :'app_user') \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA meta GRANT USAGE, SELECT ON SEQUENCES TO %I',
  current_user, :'app_user') \gexec

-- The result, read back from the catalog rather than asserted: what the API's own boot line will say.
SELECT format(
  'app-role: %s is ready -- superuser=%s bypassrls=%s; DML on %s of %s catalog tables in meta; owns %s of them',
  r.rolname, r.rolsuper, r.rolbypassrls,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'meta' AND c.relkind IN ('r', 'p') AND c.relname <> '_meta_migrations'
      AND has_table_privilege(r.rolname, c.oid, 'SELECT') AND has_table_privilege(r.rolname, c.oid, 'INSERT')
      AND has_table_privilege(r.rolname, c.oid, 'UPDATE') AND has_table_privilege(r.rolname, c.oid, 'DELETE')),
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'meta' AND c.relkind IN ('r', 'p') AND c.relname <> '_meta_migrations'),
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'meta' AND c.relowner = r.oid)) AS app_role
  FROM pg_roles r WHERE r.rolname = :'app_user';
