/**
 * Vercel Node-runtime entrypoint for `operate-server`.
 *
 * Deploy-only glue — NOT part of any workspace package (so `pnpm -r typecheck`
 * does not include it; Vercel's @vercel/node compiles it independently). It wraps
 * the same `OperateHttpServer.dispatch` core the `operate-server` bin uses in a
 * Fetch handler, backed by Postgres (Supabase). A catch-all rewrite in
 * `vercel.json` sends every request here, so the original `/v1/...` path is
 * preserved on `request.url`.
 *
 * MUST run on the Node runtime — node-postgres opens a TCP socket, which the
 * Vercel Edge runtime cannot do. Do not set `runtime: "edge"`.
 *
 * Configuration via environment variables (Vercel Project → Settings → Env):
 *   PG* (PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE/PGPORT) — Supabase connection
 *   CROSSENGIN_PACK         built-in pack alias (default "erp-retail")
 *   CROSSENGIN_MANIFEST     inline resolved-manifest JSON (overrides CROSSENGIN_PACK)
 *   CROSSENGIN_STORE        "pg" (JSONB, default) | "pg-columns" (typed tables + PHI encryption)
 *   CROSSENGIN_SCHEMA       Postgres schema (default "meta")
 *   CROSSENGIN_API_KEYS     comma-separated "token:role:tenant" specs (dev/service/admin auth)
 *   CROSSENGIN_JWKS_KEYS    comma-separated "kid:base64" Ed25519 verification keys
 *   CROSSENGIN_JWKS_URL     a JWKS endpoint serving Ed25519 keys (alternative to the above)
 *   CROSSENGIN_JWT_ISSUER   required issuer when a JWKS is configured
 *   CROSSENGIN_JWT_AUDIENCE required audience when a JWKS is configured
 *
 * NOTE: the gateway verifies EdDSA (Ed25519) JWTs only. Supabase Auth tokens
 * (HS256/RS256/ES256) will NOT verify here — use API keys, or mint your own
 * Ed25519 JWTs (Supabase can still be the upstream identity/login source).
 */
import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import type { EntityStore } from "@crossengin/operate-runtime";
import { ColumnMappedEntityStore, PostgresEntityStore } from "@crossengin/operate-runtime-pg";
import {
  buildJwksProvider,
  buildOperateHttpServer,
  createFetchHandler,
  loadBuiltinPack,
  loadManifestFromJson,
  parseApiKeySpec,
  parseJwksKeySpec,
  RemoteJwksProvider,
  type JwtVerifyConfig,
} from "@crossengin/operate-server";

type FetchHandler = (req: Request) => Promise<Response>;

let handlerPromise: Promise<FetchHandler> | undefined;

function csv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

async function build(): Promise<FetchHandler> {
  const conn: PgConnection = createNodePgConnection(parsePgEnvConfig());
  const schema = process.env["CROSSENGIN_SCHEMA"] ?? "meta";

  const manifestJson = process.env["CROSSENGIN_MANIFEST"];
  const manifest =
    manifestJson !== undefined && manifestJson.length > 0
      ? loadManifestFromJson(manifestJson)
      : await loadBuiltinPack(process.env["CROSSENGIN_PACK"] ?? "erp-retail");

  let store: EntityStore;
  if ((process.env["CROSSENGIN_STORE"] ?? "pg") === "pg-columns") {
    const columnStore = new ColumnMappedEntityStore(conn, manifest, { schema });
    await columnStore.ensureSchema();
    store = columnStore;
  } else {
    store = new PostgresEntityStore(conn, { schema });
  }

  const apiKeys = csv(process.env["CROSSENGIN_API_KEYS"]).map(parseApiKeySpec);

  let jwt: JwtVerifyConfig | undefined;
  const jwksKeys = csv(process.env["CROSSENGIN_JWKS_KEYS"]);
  const jwksUrl = process.env["CROSSENGIN_JWKS_URL"];
  if (jwksKeys.length > 0 || (jwksUrl !== undefined && jwksUrl.length > 0)) {
    jwt = {
      jwksProvider:
        jwksKeys.length > 0
          ? buildJwksProvider(jwksKeys.map(parseJwksKeySpec))
          : new RemoteJwksProvider({ url: jwksUrl! }),
      issuer: process.env["CROSSENGIN_JWT_ISSUER"] ?? "",
      audience: process.env["CROSSENGIN_JWT_AUDIENCE"] ?? "",
    };
  }

  const { httpServer } = buildOperateHttpServer({
    manifest,
    store,
    apiKeys,
    defaultScheme: "https",
    serveApiDescriptor: true,
    ...(jwt !== undefined ? { jwt } : {}),
  });
  return createFetchHandler(httpServer);
}

export default async function handler(req: Request): Promise<Response> {
  handlerPromise ??= build();
  const fetchHandler = await handlerPromise;
  return fetchHandler(req);
}
