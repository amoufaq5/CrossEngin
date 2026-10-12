-- Runs once, on first initialisation of an empty data directory.
-- Enables uuid_generate_v7() for the whole database so the migration applier's
-- pg_uuidv7 precondition passes and every meta.* id default resolves.
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
