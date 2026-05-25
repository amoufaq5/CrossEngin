import type { HttpMethod, RouteDefinition } from "@crossengin/api-gateway";
import type {
  RouteLookupInput,
  RouteLookupResult,
  RouteRegistry,
} from "@crossengin/api-gateway-runtime";
import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA = "meta";
const TABLE = "gateway_routes";

interface RouteRow {
  readonly route_id: string;
  readonly operation_id: string;
  readonly method: string;
  readonly path_segments: unknown;
  readonly api_version: string;
  readonly is_deprecated: boolean;
  readonly deprecated_since: string | null;
  readonly sunset_at: string | null;
  readonly successor_operation_id: string | null;
  readonly required_scopes: unknown;
  readonly rate_limit_policy_id: string | null;
  readonly idempotency_required: boolean;
  readonly request_schema_sha256: string | null;
  readonly response_schema_sha256: string | null;
  readonly source_pack: string | null;
}

const SELECT_COLUMNS = `route_id, operation_id, method, path_segments, api_version,
   is_deprecated, deprecated_since, sunset_at, successor_operation_id,
   required_scopes, rate_limit_policy_id, idempotency_required,
   request_schema_sha256, response_schema_sha256, source_pack`;

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
    deprecatedSince: row.deprecated_since,
    sunsetAt: row.sunset_at,
    successorOperationId: row.successor_operation_id,
    requiredScopes: scopes,
    rateLimitPolicyId: row.rate_limit_policy_id,
    idempotencyRequired: row.idempotency_required,
    requestSchemaSha256: row.request_schema_sha256,
    responseSchemaSha256: row.response_schema_sha256,
    sourcePack: row.source_pack,
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

export class PostgresRouteRegistry implements RouteRegistry {
  private readonly conn: PgConnection;
  private readonly cacheTtlMs: number;
  private readonly clock: () => number;
  private cache: {
    readonly loadedAtMs: number;
    readonly compiled: readonly CompiledRoute[];
  } | null = null;
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
         request_schema_sha256, response_schema_sha256, created_by, source_pack
       )
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16)
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
             response_schema_sha256 = EXCLUDED.response_schema_sha256,
             source_pack = EXCLUDED.source_pack`,
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
        route.sourcePack,
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

  async listAll(): Promise<readonly RouteDefinition[]> {
    const result = await this.conn.query<RouteRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM ${SCHEMA}.${TABLE}
        ORDER BY api_version, method, route_id`,
    );
    return result.rows.map(rowToRoute);
  }

  async listByPackSlug(packSlug: string): Promise<readonly RouteDefinition[]> {
    const result = await this.conn.query<RouteRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM ${SCHEMA}.${TABLE}
        WHERE source_pack = $1
        ORDER BY api_version, method, route_id`,
      [packSlug],
    );
    return result.rows.map(rowToRoute);
  }

  async deleteByRouteId(routeId: string): Promise<boolean> {
    const result = await this.conn.query(`DELETE FROM ${SCHEMA}.${TABLE} WHERE route_id = $1`, [
      routeId,
    ]);
    this.cache = null;
    return result.rowCount > 0;
  }

  async deleteByPackSlug(packSlug: string): Promise<number> {
    const result = await this.conn.query(`DELETE FROM ${SCHEMA}.${TABLE} WHERE source_pack = $1`, [
      packSlug,
    ]);
    this.cache = null;
    return result.rowCount;
  }

  private async loadCompiled(): Promise<readonly CompiledRoute[]> {
    if (this.pendingLoad !== null) {
      return this.pendingLoad;
    }
    this.pendingLoad = (async () => {
      const result = await this.conn.query<RouteRow>(
        `SELECT ${SELECT_COLUMNS}
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
