// One self-diagnosing migrate step for managed-Postgres deploys (Railway /
// Supabase / etc.). Validates the PG env, then: prereqs (pgcrypto +
// uuid_generate_v7 shim) → applies the meta-schema → seeds the demo tenant.
// Stage-logged so a failure shows exactly which step broke. Safe to run as a
// Railway Pre-Deploy Command OR by hand (`node deploy/scripts/migrate.mjs`).
//
// Why not `crossengin-pg apply`? Its preconditions require the pg_uuidv7
// EXTENSION, which managed Postgres (Railway, Supabase) doesn't offer. We instead
// apply the emitted bootstrap DDL directly through the connection — the same DDL
// scripts/setup-integration-db.sh pipes to psql — over the uuid_generate_v7()
// shim. Idempotent: skips the apply if the schema is already present.
//
// SSL note: PGSSLMODE=disable for a private host (…​.railway.internal), =require
// for a public proxy host. Default (prefer) connects without SSL.
import { emitMetaBootstrapSql } from "../../packages/kernel/dist/bootstrap/index.js";
import { createNodePgConnection, parsePgEnvConfig } from "../../packages/kernel-pg/dist/src/index.js";

for (const k of ["PGHOST", "PGUSER", "PGDATABASE"]) {
  if (!process.env[k]) {
    console.error(`migrate: ${k} is not set — configure the database variables on this service (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE)`);
    process.exit(2);
  }
}

let conn;
try {
  conn = createNodePgConnection(parsePgEnvConfig());
} catch (err) {
  console.error(`migrate: cannot build a PG connection: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

async function step(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`migrate: ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    await conn.close().catch(() => {});
    process.exit(1);
  }
}

console.log("migrate 1/3: prereqs (pgcrypto + uuid_generate_v7 shim)");
await step("prereqs", async () => {
  await conn.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await conn.query("CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()'");
});

console.log("migrate 2/3: applying meta-schema");
await step("apply", async () => {
  const present = await conn.query("SELECT to_regclass('meta.tenants') AS t");
  if (present.rows[0] && present.rows[0].t) {
    console.log("  meta-schema already present — skipping");
    return;
  }
  const statements = emitMetaBootstrapSql();
  await conn.transaction(async (tx) => {
    for (const statement of statements) await tx.query(statement);
  });
  console.log(`  meta-schema applied (${statements.length} statements)`);
});

console.log("migrate 3/3: seeding demo tenant + admin user");
await step("seed", async () => {
  await conn.query(
    `INSERT INTO meta.tenants (id, slug, name, schema_name) VALUES ($1,'demo','Demo Tenant','tenant_demo') ON CONFLICT (id) DO NOTHING`,
    ["00000000-0000-4000-8000-000000000001"],
  );
  await conn.query(
    `INSERT INTO meta.users (id, email) VALUES ($1,'admin@demo.test') ON CONFLICT (id) DO NOTHING`,
    ["00000000-0000-4000-8000-0000000000a1"],
  );
});

await conn.close().catch(() => {});
console.log("migrate: done");
