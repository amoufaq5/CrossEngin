// Env-driven entrypoint for the operate-web UI — the sibling of
// start-operate-server.mjs, for platforms that don't shell-expand the start
// command (Railway/Railpack). Reads process.env directly; boots with zero API
// keys (requests then 401) so a missing key never crash-loops the deploy.
//
// Config: PORT (default 8090), CROSSENGIN_PACK (default erp-retail),
//   CROSSENGIN_MANIFEST, CROSSENGIN_STORE (memory|pg|pg-columns, default pg),
//   CROSSENGIN_SCHEMA, CROSSENGIN_API_KEYS (comma token:role:tenant), JWKS env
//   (CROSSENGIN_JWKS_KEYS | CROSSENGIN_JWKS_URL | CROSSENGIN_JWKS_FILE +
//   CROSSENGIN_JWT_ISSUER / CROSSENGIN_JWT_AUDIENCE / CROSSENGIN_JWKS_REFRESH_MS).
import { serve } from "../../apps/operate-web/dist/src/index.js";

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
  port: Number(env["PORT"]) || 8090,
  pack: manifestPath !== null ? null : (env["CROSSENGIN_PACK"] ?? "erp-retail"),
  manifestPath,
  apiKeys: list(env["CROSSENGIN_API_KEYS"]),
  store: env["CROSSENGIN_STORE"] ?? "pg",
  schema: orNull(env["CROSSENGIN_SCHEMA"]),
  jwksKeys,
  jwksFile,
  jwksUrl,
  jwksRefreshMs: env["CROSSENGIN_JWKS_REFRESH_MS"] ? Number(env["CROSSENGIN_JWKS_REFRESH_MS"]) : null,
  jwtIssuer,
  jwtAudience,
  help: false,
  version: false,
};

const running = await serve(options);
console.log(
  `operate-web listening on :${options.port} ` +
    `(${options.manifestPath ?? "pack " + options.pack}, store=${options.store}, apiKeys=${options.apiKeys.length})`,
);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    running.close().then(() => process.exit(0), () => process.exit(1));
  });
}
