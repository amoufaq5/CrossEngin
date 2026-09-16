import { readFile } from "node:fs/promises";
import { emitMetaBootstrapSql, META_SCHEMA_NAME } from "@crossengin/kernel/bootstrap";
import { MigrationApplier, createNodePgConnection, parsePgEnvConfig } from "@crossengin/kernel-pg";
import { ColumnMappedEntityStore } from "@crossengin/operate-runtime-pg";
import { loadBuiltinPack } from "@crossengin/operate-server";

const role = process.env.APP_DB_USER ?? "crossengin_app";
const password = process.env.APP_DB_PASSWORD ?? "";
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role) || password.length < 32 || /change-me|REPLACE_WITH/i.test(password)) throw new Error("Set APP_DB_USER and a strong APP_DB_PASSWORD (32+ characters)");
const conn = createNodePgConnection(parsePgEnvConfig());
try {
  const result = await new MigrationApplier({ connection: conn, schema: META_SCHEMA_NAME, statements: emitMetaBootstrapSql() }).apply();
  if (!result.preconditions.ok || result.failed) throw new Error("Schema migration failed; inspect migration log before retrying");
  await conn.query(await readFile(new URL("./migrations/001-production-foundations.sql", import.meta.url), "utf8"));
  const manifest = await loadBuiltinPack(process.env.OPERATE_PACK ?? "erp-core");
  // DDL runs only in this privileged one-shot process, never in the application process.
  await new ColumnMappedEntityStore(conn, manifest).ensureSchema();
  const exists = await conn.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  const quotedPassword = "'" + password.replaceAll("'", "''") + "'";
  if (!exists.rowCount) await conn.query(`CREATE ROLE "${role}" LOGIN PASSWORD ${quotedPassword}`);
  await conn.query(`ALTER ROLE "${role}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quotedPassword}`);
  for (const schema of ["meta", "public"]) {
    await conn.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await conn.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
    await conn.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`);
  }
  console.log("Migrations and application-role grants completed");
} finally { await conn.close(); }
