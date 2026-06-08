import { BUILTIN_PACK_NAMES } from "./manifest-source.js";

export type WebStoreKind = "memory" | "pg" | "pg-columns";

export interface WebServeOptions {
  readonly port: number;
  readonly pack: string | null;
  readonly manifestPath: string | null;
  readonly apiKeys: readonly string[];
  /** Entity store backing the view-model data routes. */
  readonly store: WebStoreKind;
  /** Postgres schema for the entity store (pg → meta, pg-columns → public when null). */
  readonly schema: string | null;
  /** JWKS public keys as `kid:base64` (repeatable). */
  readonly jwksKeys: readonly string[];
  /** Path to a JWKS JSON document (an alternative key source). */
  readonly jwksFile: string | null;
  /** Remote JWKS endpoint URL (caching, rotation-aware). */
  readonly jwksUrl: string | null;
  /** Background JWKS refresh interval in ms (with --jwks-url; >= 1000). */
  readonly jwksRefreshMs: number | null;
  /** Expected JWT issuer (required when a JWKS is configured). */
  readonly jwtIssuer: string | null;
  /** Expected JWT audience (required when a JWKS is configured). */
  readonly jwtAudience: string | null;
  readonly help: boolean;
  readonly version: boolean;
}

export class CliUsageError extends Error {}

const DEFAULT_PORT = 8788;

function takeValue(arg: string, next: string | undefined, flag: string): string {
  if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
  if (next === undefined) throw new CliUsageError(`flag ${flag} requires a value`);
  return next;
}

function isInline(arg: string): boolean {
  return arg.includes("=");
}

/**
 * Parses `operate-web` argv into `WebServeOptions`. Supports `--flag value` and
 * `--flag=value`; `--api-key` repeats. Exactly one of `--pack` / `--manifest` is
 * required (unless `--help` / `--version`).
 */
export function parseWebArgs(argv: readonly string[]): WebServeOptions {
  let port = DEFAULT_PORT;
  let pack: string | null = null;
  let manifestPath: string | null = null;
  const apiKeys: string[] = [];
  let store: WebStoreKind = "memory";
  let schema: string | null = null;
  const jwksKeys: string[] = [];
  let jwksFile: string | null = null;
  let jwksUrl: string | null = null;
  let jwksRefreshMs: number | null = null;
  let jwtIssuer: string | null = null;
  let jwtAudience: string | null = null;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = argv[i + 1];
    const consumed = (): number => (isInline(arg) ? 0 : 1);
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg === "--port" || arg.startsWith("--port=")) {
      const raw = takeValue(arg, next, "--port");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new CliUsageError(`invalid --port: ${raw}`);
      port = n;
      i += consumed();
    } else if (arg === "--pack" || arg.startsWith("--pack=")) {
      pack = takeValue(arg, next, "--pack");
      i += consumed();
    } else if (arg === "--manifest" || arg.startsWith("--manifest=")) {
      manifestPath = takeValue(arg, next, "--manifest");
      i += consumed();
    } else if (arg === "--api-key" || arg.startsWith("--api-key=")) {
      apiKeys.push(takeValue(arg, next, "--api-key"));
      i += consumed();
    } else if (arg === "--store" || arg.startsWith("--store=")) {
      const raw = takeValue(arg, next, "--store");
      if (raw !== "memory" && raw !== "pg" && raw !== "pg-columns") {
        throw new CliUsageError(`invalid --store: ${raw} (memory|pg|pg-columns)`);
      }
      store = raw;
      i += consumed();
    } else if (arg === "--schema" || arg.startsWith("--schema=")) {
      schema = takeValue(arg, next, "--schema");
      i += consumed();
    } else if (arg === "--jwks-key" || arg.startsWith("--jwks-key=")) {
      jwksKeys.push(takeValue(arg, next, "--jwks-key"));
      i += consumed();
    } else if (arg === "--jwks-file" || arg.startsWith("--jwks-file=")) {
      jwksFile = takeValue(arg, next, "--jwks-file");
      i += consumed();
    } else if (arg === "--jwks-url" || arg.startsWith("--jwks-url=")) {
      jwksUrl = takeValue(arg, next, "--jwks-url");
      i += consumed();
    } else if (arg === "--jwks-refresh-ms" || arg.startsWith("--jwks-refresh-ms=")) {
      const raw = takeValue(arg, next, "--jwks-refresh-ms");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1000) throw new CliUsageError(`invalid --jwks-refresh-ms: ${raw} (>= 1000)`);
      jwksRefreshMs = n;
      i += consumed();
    } else if (arg === "--jwt-issuer" || arg.startsWith("--jwt-issuer=")) {
      jwtIssuer = takeValue(arg, next, "--jwt-issuer");
      i += consumed();
    } else if (arg === "--jwt-audience" || arg.startsWith("--jwt-audience=")) {
      jwtAudience = takeValue(arg, next, "--jwt-audience");
      i += consumed();
    } else {
      throw new CliUsageError(`unknown argument: ${arg}`);
    }
  }

  if (!help && !version) {
    if (pack === null && manifestPath === null) {
      throw new CliUsageError("one of --pack or --manifest is required");
    }
    if (pack !== null && manifestPath !== null) {
      throw new CliUsageError("--pack and --manifest are mutually exclusive");
    }
    const jwksConfigured = jwksKeys.length > 0 || jwksFile !== null || jwksUrl !== null;
    if (jwksConfigured && (jwtIssuer === null || jwtAudience === null)) {
      throw new CliUsageError("--jwt-issuer and --jwt-audience are required when a JWKS is configured");
    }
    if (jwksKeys.length > 0 && jwksFile !== null) {
      throw new CliUsageError("--jwks-key and --jwks-file are mutually exclusive");
    }
    if (jwksUrl !== null && (jwksKeys.length > 0 || jwksFile !== null)) {
      throw new CliUsageError("--jwks-url and --jwks-key/--jwks-file are mutually exclusive");
    }
  }

  return { port, pack, manifestPath, apiKeys, store, schema, jwksKeys, jwksFile, jwksUrl, jwksRefreshMs, jwtIssuer, jwtAudience, help, version };
}

export const helpText = `operate-web — serve a resolved CrossEngin manifest as redaction-aware UI view models

Usage:
  operate-web --pack <name> [options]
  operate-web --manifest <file.json> [options]

Manifest source (exactly one):
  --pack <name>        Built-in vertical pack: ${BUILTIN_PACK_NAMES.join(", ")}
  --manifest <file>    Path to a resolved manifest JSON document

Options:
  --port <n>           Port to listen on (default 8788)
  --api-key <spec>     API key binding key:role:tenant (repeatable)
  --store <kind>       Entity store: memory | pg (JSONB) | pg-columns (typed
                       per-entity tables) (default memory)
  --schema <name>      Postgres schema for the entity store (default meta;
                       public for pg-columns)
  --jwks-key <spec>    JWKS public key kid:base64 (repeatable)
  --jwks-file <file>   Path to a JWKS JSON document
  --jwks-url <url>     Remote JWKS endpoint (caching, rotation-aware)
  --jwks-refresh-ms <n> Background JWKS refresh interval (with --jwks-url; >=1000)
  --jwt-issuer <iss>   Expected JWT issuer (required with a JWKS)
  --jwt-audience <aud> Expected JWT audience (required with a JWKS)
  --help, -h           Show this help
  --version, -v        Print version

Auth: dev API keys (--api-key) and production JWTs (--jwks-* + --jwt-*) coexist.
A verified Bearer JWT resolves a viewer from its claims (scopes -> roles, sub ->
uuid, tenant from the tenant_id claim or the x-tenant-id header).

Routes (all GET; auth via x-api-key or Authorization: Bearer <key|jwt>):
  JSON view-model API —
    /ui/app              The app view model (title + per-entity nav)
    /ui/:entity          { table, page: { data, nextCursor } } — model + data page
    /ui/:entity/kanban   { kanban, page } — board model + cards (404 if no kanban view)
    /ui/:entity/calendar { calendar, page } — calendar model + events (404 if none)
    /ui/:entity/map      { map, page } — map model + markers (404 if no map view)
    /ui/:entity/new      { form } — the create form model
    /ui/:entity/:id      { detail, record } — record view + the record
  SSR React HTML pages (hydrated by /assets/operate-web-client.js) —
    /app                 the app shell + nav
    /app/:entity         the table page (sort + paginate)
    /app/:entity/kanban  the kanban board page (when a kanban view is declared)
    /app/:entity/calendar the calendar agenda page (when a calendar view is declared)
    /app/:entity/new     the create form page (submits POST /ui/:entity)
    /app/:entity/:id     the detail page (Edit / Delete when authorized)
    /app/:entity/:id/edit the edit form page (submits PATCH /ui/:entity/:id)
  /assets/operate-web-client.js   the hydration bundle (built via build:client)

Every model, data row, and embedded hydration state is compiled / redacted for
the caller's role, so a field the viewer can't read never appears — in the JSON,
the server-rendered HTML, or the client bundle's state.
`;
