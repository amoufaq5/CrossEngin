-- CrossEngin on Supabase: pure-SQL uuid_generate_v7().
--
-- The meta-schema defaults every table's `id` to `uuid_generate_v7()`. On
-- self-managed Postgres that function comes from the `pg_uuidv7` C extension —
-- but Supabase does not offer that extension. This defines the SAME function
-- name in pure SQL, so the schema's defaults resolve unchanged and the
-- migration applier's precondition (which accepts the callable function, not
-- only the extension) passes.
--
-- Run this ONCE per Supabase project, in the SQL Editor, BEFORE `crossengin
-- apply`. It is idempotent (CREATE OR REPLACE) and safe to re-run.

-- gen_random_uuid() lives in pgcrypto; enabled by default on Supabase, but make
-- it explicit so this file also works on a bare Postgres.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Canonical community implementation (millisecond precision): start from a
-- random v4 UUID, overlay the first 48 bits with the current Unix epoch in
-- milliseconds, then flip the version nibble from 4 (0100) to 7 (0111).
CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS uuid
AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
$$ LANGUAGE sql VOLATILE;

-- Sanity check: the generated value must report UUID version 7.
DO $$
DECLARE
  v uuid := uuid_generate_v7();
BEGIN
  IF substring(v::text FROM 15 FOR 1) <> '7' THEN
    RAISE EXCEPTION 'uuid_generate_v7() produced a non-v7 UUID: %', v;
  END IF;
END;
$$;
