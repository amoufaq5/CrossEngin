/**
 * Seeds a demo tenant + admin user with FIXED ids so the all-in-one stack is
 * usable the moment it boots (the API service's --api-key can reference the
 * tenant id without a manual round-trip). Idempotent. Reads PG* env vars.
 *
 * DEMO ONLY — for production, create real tenants/users (see docs/deploy-online.md
 * §2 and §6d) and rotate the API key.
 */
import { createNodePgConnection, parsePgEnvConfig } from "../../packages/kernel-pg/dist/src/index.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_USER_ID = "00000000-0000-4000-8000-0000000000a1";

const conn = createNodePgConnection(parsePgEnvConfig());
try {
  await conn.query(
    `INSERT INTO meta.tenants (id, slug, name, schema_name)
     VALUES ($1, 'demo', 'Demo Tenant', 'tenant_demo')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_ID],
  );
  await conn.query(
    `INSERT INTO meta.users (id, email)
     VALUES ($1, 'admin@demo.test')
     ON CONFLICT (id) DO NOTHING`,
    [ADMIN_USER_ID],
  );
  console.log(`seed ok: tenant ${TENANT_ID}, admin user ${ADMIN_USER_ID}`);
} finally {
  await conn.close();
}
