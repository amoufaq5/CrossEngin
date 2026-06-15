// Env-driven entrypoint for operate-server on platforms whose start command is
// NOT run through a shell that expands `${VAR:-default}` (Railway/Railpack,
// etc.). It reads process.env directly — no shell expansion — applies JS
// defaults, and calls the same serve() the bin uses. It boots even with zero
// API keys (the server then 401s requests rather than crash-looping), so a
// missing CROSSENGIN_API_KEYS never fails the deploy.
//
// Config (all optional):
//   PORT (default 8080)                CROSSENGIN_PACK (default erp-retail)
//   CROSSENGIN_MANIFEST (path; overrides PACK)
//   CROSSENGIN_STORE (memory|pg|pg-columns, default pg)   CROSSENGIN_SCHEMA
//   CROSSENGIN_SCHEME (http|https, default https)
//   CROSSENGIN_API_KEYS (comma list of token:role:tenant[:principalId])
//   CROSSENGIN_JWKS_KEYS (comma kid:base64) | CROSSENGIN_JWKS_URL | CROSSENGIN_JWKS_FILE
//   CROSSENGIN_JWT_ISSUER  CROSSENGIN_JWT_AUDIENCE  CROSSENGIN_JWKS_REFRESH_MS
import { serve } from "../../apps/operate-server/dist/src/index.js";

const env = process.env;
const list = (v) => (v ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
const orNull = (v) => (v !== undefined && v.length > 0 ? v : null);

const manifestPath = orNull(env["CROSSENGIN_MANIFEST"]);
const jwksKeys = list(env["CROSSENGIN_JWKS_KEYS"]);
const jwksUrl = orNull(env["CROSSENGIN_JWKS_URL"]);
const jwksFile = orNull(env["CROSSENGIN_JWKS_FILE"]);
const jwtIssuer = orNull(env["CROSSENGIN_JWT_ISSUER"]);
const jwtAudience = orNull(env["CROSSENGIN_JWT_AUDIENCE"]);

if ((jwksKeys.length > 0 || jwksUrl !== null || jwksFile !== null) && (jwtIssuer === null || jwtAudience === null)) {
  console.error("CROSSENGIN_JWT_ISSUER and CROSSENGIN_JWT_AUDIENCE are required when a JWKS is configured");
  process.exit(2);
}

const options = {
  port: Number(env["PORT"]) || 8080,
  pack: manifestPath !== null ? null : (env["CROSSENGIN_PACK"] ?? "erp-retail"),
  manifestPath,
  store: env["CROSSENGIN_STORE"] ?? "pg",
  schema: orNull(env["CROSSENGIN_SCHEMA"]),
  apiKeys: list(env["CROSSENGIN_API_KEYS"]),
  jwksKeys,
  jwksFile,
  jwksUrl,
  jwksRefreshMs: env["CROSSENGIN_JWKS_REFRESH_MS"] ? Number(env["CROSSENGIN_JWKS_REFRESH_MS"]) : null,
  jwtIssuer,
  jwtAudience,
  defaultScheme: env["CROSSENGIN_SCHEME"] === "http" ? "http" : "https",
  persistExecutions: env["CROSSENGIN_PERSIST_EXECUTIONS"] === "1",
  marketplace: env["CROSSENGIN_MARKETPLACE"] === "1",
  invalidationChannel: false,
  region: orNull(env["CROSSENGIN_REGION"]),
  tenantResidency: [],
  slo: env["CROSSENGIN_SLO"] === "1",
  sloPersist: env["CROSSENGIN_SLO_PERSIST"] === "1",
  sloActor: orNull(env["CROSSENGIN_SLO_ACTOR"]),
  sloIntervalMs: null,
  sloLatencyBudget: null,
  help: false,
  version: false,
};

const running = await serve(options);
console.log(
  `operate-server listening on :${options.port} ` +
    `(${options.manifestPath ?? "pack " + options.pack}, store=${options.store}, apiKeys=${options.apiKeys.length})`,
);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    running.close().then(() => process.exit(0), () => process.exit(1));
  });
}
