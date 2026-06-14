/**
 * Idempotent Postgres prerequisites for CrossEngin (run BEFORE `crossengin-pg apply`).
 *
 * Used by the all-in-one Docker Compose + Render flows where there's no SQL
 * editor / initdb hook. On Supabase use the SQL file under
 * deploy/supabase/migrations/ instead. Reads the standard PG* env vars.
 */
import { createNodePgConnection, parsePgEnvConfig } from "../../packages/kernel-pg/dist/src/index.js";

const conn = createNodePgConnection(parsePgEnvConfig());
try {
  await conn.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await conn.query(
    "CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()'",
  );
  console.log("prereqs ok: pgcrypto + uuid_generate_v7() shim");
} finally {
  await conn.close();
}
