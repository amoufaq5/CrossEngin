-- CrossEngin prerequisites for a Supabase Postgres database.
--
-- Run this BEFORE applying the meta-schema (`crossengin-pg apply`).
-- You can paste it into the Supabase SQL Editor, or keep it as a Supabase CLI
-- migration (supabase/migrations/<timestamp>_crossengin_prereqs.sql).

-- pgcrypto powers the `pg-columns` store's transparent at-rest encryption of
-- phi/regulated columns (pgp_sym_encrypt / pgp_sym_decrypt). It is in Supabase's
-- default extension allowlist.
create extension if not exists pgcrypto;

-- The meta-schema defaults UUID PK columns to uuid_generate_v7(). Production uses
-- the pg_uuidv7 extension; Supabase does not expose it in the default allowlist,
-- so provide a shim over gen_random_uuid() (UUIDv4). It is functionally fine —
-- the only difference is v7's time-ordering. If your project can enable a real
-- v7 source, drop this shim and use it instead.
create or replace function uuid_generate_v7() returns uuid
  language sql volatile as 'select gen_random_uuid()';
