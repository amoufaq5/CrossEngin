import type { HttpMethod, RouteDefinition } from "@crossengin/api-gateway";
import type {
  RouteLookupInput,
  RouteLookupResult,
  RouteRegistry,
} from "@crossengin/api-gateway-runtime";
import { isoInstant, type PgConnection } from "@crossengin/kernel-pg";

const SCHEMA = "meta";
const TABLE = "gateway_routes";

interface RouteRow {
  readonly route_id: string;
  readonly operation_id: string;
  readonly method: string;
  readonly path_segments: unknown;
  readonly api_version: string;
  readonly is_deprecated: boolean;
  /**
   * `unknown`: node-postgres returns a `TIMESTAMPTZ` as a `Date`. `sunset_at` is compared in
   * `matchRoute` (`now.getTime() >= Date.parse(r.sunsetAt)`) and, worse, emitted verbatim as the
   * RFC 8594 `Sunset` response header — where a `Date`'s `toString()` form is not a valid
   * HTTP-date and tells a client nothing it can parse.
   */
  readonly deprecated_since: unknown;
  readonly sunset_at: unknown;
  readonly successor_operation_id: string | null;
  readonly required_scopes: unknown;
  readonly rate_limit_policy_id: string | null;
  readonly idempotency_required: boolean;
  readonly request_schema_sha256: string | null;
  readonly response_schema_sha256: string | null;
}

function asJsonArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function rowToRoute(row: RouteRow): RouteDefinition {
  const segments = asJsonArray(row.path_segments) as RouteDefinition["pathSegments"];
  const scopes = asJsonArray(row.required_scopes).map((s) => String(s));
  return {
    id: row.route_id,
    operationId: row.operation_id,
    method: row.method as HttpMethod,
    pathSegments: segments,
    apiVersion: row.api_version,
    isDeprecated: row.is_deprecated,
    deprecatedSince: isoInstant(row.deprecated_since),
    sunsetAt: isoInstant(row.sunset_at),
    successorOperationId: row.successor_operation_id,
    requiredScopes: scopes,
    rateLimitPolicyId: row.rate_limit_policy_id,
    idempotencyRequired: row.idempotency_required,
    requestSchemaSha256: row.request_schema_sha256,
    responseSchemaSha256: row.response_schema_sha256,
  };
}

interface CompiledRoute {
  readonly route: RouteDefinition;
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
}

function compilePattern(route: RouteDefinition): CompiledRoute {
  const paramNames: string[] = [];
  const parts: string[] = [];
  for (const segment of route.pathSegments) {
    if (segment.kind === "literal") {
      parts.push(escapeRegex(segment.value));
    } else if (segment.kind === "parameter") {
      paramNames.push(segment.name);
      parts.push(segment.pattern !== null ? `(${segment.pattern})` : "([^/]+)");
    } else {
      parts.push("(.*)");
    }
  }
  return {
    route,
    regex: new RegExp(`^/${parts.join("/")}/?$`),
    paramNames,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface PostgresRouteRegistryOptions {
  readonly conn: PgConnection;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

/**
 * **This class has no caller in the workspace, and that is a decision rather than a gap.** It is
 * written down here because the storeless-table rule asks which catalogued table has no store, and
 * nothing yet asks which store has no caller — so without this paragraph the next census reads a
 * silence and cannot tell a refusal from an omission.
 *
 * `PostgresRouteRegistry` implements `RouteRegistry` over `meta.gateway_routes`, which is a
 * *published* route surface: rows are authored, a gateway loads them, and the served API is
 * whatever the table says. This platform does not serve that way. `compileOperateServer` derives
 * routes **and their handlers in one pass** from the resolved manifest, keyed on `operationId`, so
 * the two halves of a route are produced together and cannot disagree. Substituting this registry
 * breaks that in both directions, and neither failure is loud:
 *
 * - a row the manifest did not produce has **no handler**, so it matches, authenticates, consumes
 *   its rate-limit budget and then resolves to `no_handler` — a 404 for a route the table says
 *   exists;
 * - a manifest route **absent** from the table stops matching at all, so activating a manifest
 *   would silently un-serve part of it until somebody remembered to publish the rows.
 *
 * Two mechanical facts confirm it is not a drop-in even setting that aside. `lookup` is
 * synchronous and answers `null` on a cold cache, so the first requests after a boot or a TTL lapse
 * are unroutable unless an `ensureLoaded()` is awaited somewhere off the request path — a
 * requirement the interface cannot express. And `node.ts` reads `gateway.routes.list()` for
 * `surveyRoutePolicies`; `list()` is deliberately **not** on `RouteRegistry` (see the note on
 * `InMemoryRouteRegistry.list`) precisely because enumerating a TTL-cached table is a query with a
 * different cost and a different answer, so this class does not and should not have it.
 *
 * What is *not* the reason: the table is platform-wide with no `tenant_id` and no RLS, so none of
 * the owner-bypass or missing-context defects that made `PostgresIdempotencyStore` unusable apply
 * here. The SQL is fine. It answers a question this architecture does not ask.
 *
 * The one piece with standalone value is `upsert`, which could *publish* the compiled surface for
 * observability — `rate_limit_policy_id` is the only persisted statement of which policy governs a
 * route, and `surveyRoutePolicies` computes that in memory and prints it. Deliberately not taken
 * here: writing rows nothing reads would make `meta.gateway_routes` look like the authority on the
 * served surface when the manifest is, which is a worse state than an empty table.
 */
export class PostgresRouteRegistry implements RouteRegistry {
  private readonly conn: PgConnection;
  private readonly cacheTtlMs: number;
  private readonly clock: () => number;
  private cache: { readonly loadedAtMs: number; readonly compiled: readonly CompiledRoute[] } | null = null;
  private pendingLoad: Promise<readonly CompiledRoute[]> | null = null;

  constructor(opts: PostgresRouteRegistryOptions) {
    this.conn = opts.conn;
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000;
    this.clock = opts.now ?? (() => Date.now());
  }

  async refresh(): Promise<void> {
    this.cache = null;
    await this.loadCompiled();
  }

  async upsert(route: RouteDefinition, createdByUserId: string): Promise<void> {
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (
         route_id, operation_id, method, path_segments, api_version,
         is_deprecated, deprecated_since, sunset_at, successor_operation_id,
         required_scopes, rate_limit_policy_id, idempotency_required,
         request_schema_sha256, response_schema_sha256, created_by
       )
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)
       ON CONFLICT (route_id) DO UPDATE
         SET operation_id = EXCLUDED.operation_id,
             method = EXCLUDED.method,
             path_segments = EXCLUDED.path_segments,
             api_version = EXCLUDED.api_version,
             is_deprecated = EXCLUDED.is_deprecated,
             deprecated_since = EXCLUDED.deprecated_since,
             sunset_at = EXCLUDED.sunset_at,
             successor_operation_id = EXCLUDED.successor_operation_id,
             required_scopes = EXCLUDED.required_scopes,
             rate_limit_policy_id = EXCLUDED.rate_limit_policy_id,
             idempotency_required = EXCLUDED.idempotency_required,
             request_schema_sha256 = EXCLUDED.request_schema_sha256,
             response_schema_sha256 = EXCLUDED.response_schema_sha256`,
      [
        route.id,
        route.operationId,
        route.method,
        JSON.stringify(route.pathSegments),
        route.apiVersion,
        route.isDeprecated,
        route.deprecatedSince,
        route.sunsetAt,
        route.successorOperationId,
        JSON.stringify(route.requiredScopes),
        route.rateLimitPolicyId,
        route.idempotencyRequired,
        route.requestSchemaSha256,
        route.responseSchemaSha256,
        createdByUserId,
      ],
    );
    this.cache = null;
  }

  lookup(input: RouteLookupInput): RouteLookupResult | null {
    if (this.cache === null) return null;
    for (const compiled of this.cache.compiled) {
      if (compiled.route.method !== input.method) continue;
      if (compiled.route.apiVersion !== input.apiVersion) continue;
      const match = compiled.regex.exec(input.path);
      if (match === null) continue;
      const params: Record<string, string> = {};
      compiled.paramNames.forEach((name, i) => {
        const v = match[i + 1];
        if (v !== undefined) params[name] = v;
      });
      return { route: compiled.route, params };
    }
    return null;
  }

  listVersionsFor(method: HttpMethod, path: string): readonly string[] {
    if (this.cache === null) return [];
    const versions = new Set<string>();
    for (const compiled of this.cache.compiled) {
      if (compiled.route.method !== method) continue;
      if (compiled.regex.test(path)) {
        versions.add(compiled.route.apiVersion);
      }
    }
    return [...versions];
  }

  async ensureLoaded(): Promise<void> {
    if (this.cache !== null && this.clock() - this.cache.loadedAtMs < this.cacheTtlMs) {
      return;
    }
    await this.loadCompiled();
  }

  private async loadCompiled(): Promise<readonly CompiledRoute[]> {
    if (this.pendingLoad !== null) {
      return this.pendingLoad;
    }
    this.pendingLoad = (async () => {
      const result = await this.conn.query<RouteRow>(
        `SELECT route_id, operation_id, method, path_segments, api_version,
                is_deprecated, deprecated_since, sunset_at, successor_operation_id,
                required_scopes, rate_limit_policy_id, idempotency_required,
                request_schema_sha256, response_schema_sha256
           FROM ${SCHEMA}.${TABLE}
          ORDER BY api_version, method, route_id`,
      );
      const compiled = result.rows.map((row) => compilePattern(rowToRoute(row)));
      this.cache = { loadedAtMs: this.clock(), compiled };
      return compiled;
    })().finally(() => {
      this.pendingLoad = null;
    });
    return this.pendingLoad;
  }
}
