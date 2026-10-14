-- Run TWICE, by two readers, and everything here must be idempotent.
--
--   1. by the `db` container's entrypoint, from /docker-entrypoint-initdb.d, which fires ONLY on
--      the first initialisation of an empty data directory; and
--   2. by the one-shot `extensions` service in docker-compose.yml, on every `up`.
--
-- The second reader exists because the first is not enough: a `db-data` volume that already holds a
-- cluster never sees this file again, so an image fixed after the fact cannot repair a database
-- created before it — the symptom being `crossengin apply` exiting 1 with
-- `PRECONDITIONS FAILED … [MISSING_EXTENSION]` on every `up`, with the container reporting healthy.
-- A precondition the migrate step needs on every run cannot live only in a hook that runs once.
--
-- Enables uuid_generate_v7() for the whole database so the migration applier's pg_uuidv7
-- precondition passes and every meta.* id default resolves.
CREATE EXTENSION IF NOT EXISTS pg_uuidv7;

-- Backs at-rest column encryption (pgp_sym_encrypt/decrypt) for `phi`/`regulated` fields; without
-- it EncryptionApplier.coverage reports pgcrypto_missing and nothing in deploy/ ever runs
-- `crossengin-pg encrypt --provision` to install it.
--
-- Guarded, unlike pg_uuidv7 above, and the asymmetry is the point. The entrypoint runs these files
-- with ON_ERROR_STOP=1, so a failing CREATE EXTENSION aborts initialisation and the container never
-- comes up. pg_uuidv7 *should* do that -- though not for the reason this comment used to give. It
-- said "the applier hard-requires it … so a database without it is unusable", and that is false:
-- `checkPgUuidv7Extension` asks pg_extension OR pg_proc, so a pure-SQL `uuid_generate_v7()`
-- satisfies it, which is the whole managed-provider path (deploy/supabase/00-uuidv7.sql). The real
-- reason is narrower and still decisive: this image is BUILT to install the extension, so an image
-- in which `CREATE EXTENSION` fails is a broken build, and a database that silently fell back would
-- hide it while taking a per-row SQL function on every INSERT. Fail at initdb, where the Dockerfile
-- is still the thing to look at. pgcrypto is needed only by a manifest
-- declaring a phi/regulated field -- zero of them in erp-core, which is this compose file's default
-- pack -- and the serving store already calls ensurePgcryptoExtension when a plan needs it. So a
-- missing pgcrypto must not take down a deployment that does not need it; it degrades to a boot
-- refusal naming the entity and field, which is a far better failure than a database that will not
-- start. Verified both arms on PG 16: EXECUTE inside a DO block does create the extension, and an
-- unavailable one is caught here with psql still exiting 0.
DO $$
BEGIN
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgcrypto';
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING
    'pgcrypto could not be installed (%) -- at-rest encryption of phi/regulated columns is unavailable; operate-server will refuse to serve a manifest declaring one',
    SQLERRM;
END $$;

-- Backs `?q=` and every `[contains]` filter. `list-sql.ts` is shared by BOTH Postgres stores and
-- emits `unaccent(<expr>::text) ILIKE …` unconditionally, so without this extension every search is
-- `function unaccent(text) does not exist` -- a 500, not a slow query, and in the reference picker's
-- typeahead an EMPTY DROPDOWN rather than an error, which reads as "no matching records".
--
-- It was created in exactly one place, `ensureColumnStoreExtensions`, whose only caller is the
-- per-tenant COLUMN-store applier -- so `--store pg`, this compose file's default, never had it.
-- The serving binary provisions it at boot now for both stores, and this line is the half that
-- covers the deployment the binary cannot: `CREATE EXTENSION` needs privileges a least-privilege
-- serving role does not hold, and these files run as the superuser.
--
-- Guarded like pgcrypto above and for the same reason: the entrypoint runs this file with
-- ON_ERROR_STOP=1, so a failing CREATE EXTENSION aborts initialisation and the container never comes
-- up. A deployment with no search still serves every list, record, filter and sort, so that trade is
-- the wrong way round -- and the boot line says `unaccent: REFUSED` with the one statement to run.
DO $$
BEGIN
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS unaccent';
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING
    'unaccent could not be installed (%) -- ?q= and every [contains] filter will answer 500, and a reference picker will show an empty dropdown',
    SQLERRM;
END $$;
