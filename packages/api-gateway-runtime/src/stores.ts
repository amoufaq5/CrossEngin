import type {
  IdempotencyRecord,
  IncomingRequest,
  ResolvedPrincipal,
  RouteDefinition,
} from "@crossengin/api-gateway";

export interface PrincipalResolverInput {
  readonly tenantId: string | null;
  readonly principalRef: string;
  readonly scopes: readonly string[];
  readonly authScheme: string;
}

export interface PrincipalResolver {
  resolve(input: PrincipalResolverInput): Promise<ResolvedPrincipal | null>;
}

export interface IdempotencyStore {
  get(input: { readonly tenantId: string; readonly key: string }): Promise<IdempotencyRecord | null>;
  put(input: { readonly tenantId: string; readonly record: IdempotencyRecord }): Promise<void>;
  update(input: { readonly tenantId: string; readonly key: string; readonly mutate: (rec: IdempotencyRecord) => IdempotencyRecord }): Promise<IdempotencyRecord>;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
  readonly decisionId: string;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: string;
  readonly quotaExceeded?: boolean;
  readonly reason: string;
}

export interface RateLimitCheckInput {
  readonly tenantId: string | null;
  readonly principalId: string | null;
  readonly route: RouteDefinition | null;
  readonly request: IncomingRequest;
  readonly now: Date;
}

export interface RateLimitChecker {
  check(input: RateLimitCheckInput): Promise<RateLimitDecision>;
}

export interface RouteLookupInput {
  readonly method: IncomingRequest["method"];
  readonly path: string;
  readonly apiVersion: string;
}

export interface RouteLookupResult {
  readonly route: RouteDefinition;
  readonly params: Readonly<Record<string, string>>;
}

export interface RouteRegistry {
  lookup(input: RouteLookupInput): RouteLookupResult | null;
  listVersionsFor(method: IncomingRequest["method"], path: string): readonly string[];
}

export class InMemoryPrincipalResolver implements PrincipalResolver {
  private readonly byRef: Map<string, ResolvedPrincipal> = new Map();

  register(ref: string, principal: ResolvedPrincipal): this {
    this.byRef.set(ref, principal);
    return this;
  }

  async resolve(input: PrincipalResolverInput): Promise<ResolvedPrincipal | null> {
    return this.byRef.get(input.principalRef) ?? null;
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records: Map<string, IdempotencyRecord> = new Map();

  private keyFor(tenantId: string, key: string): string {
    return `${tenantId}|${key}`;
  }

  async get(input: { tenantId: string; key: string }): Promise<IdempotencyRecord | null> {
    return this.records.get(this.keyFor(input.tenantId, input.key)) ?? null;
  }

  async put(input: { tenantId: string; record: IdempotencyRecord }): Promise<void> {
    this.records.set(this.keyFor(input.tenantId, input.record.idempotencyKey), input.record);
  }

  async update(input: {
    tenantId: string;
    key: string;
    mutate: (rec: IdempotencyRecord) => IdempotencyRecord;
  }): Promise<IdempotencyRecord> {
    const existing = await this.get(input);
    if (existing === null) {
      throw new Error(`no idempotency record for tenant=${input.tenantId} key=${input.key}`);
    }
    const updated = input.mutate(existing);
    this.records.set(this.keyFor(input.tenantId, input.key), updated);
    return updated;
  }

  size(): number {
    return this.records.size;
  }
}

export class InMemoryRateLimitChecker implements RateLimitChecker {
  private readonly buckets: Map<string, { count: number; resetAtMs: number }> = new Map();
  private decisionCounter = 0;
  private readonly limit: number;
  private readonly windowSeconds: number;

  constructor(opts: { readonly limit?: number; readonly windowSeconds?: number } = {}) {
    this.limit = opts.limit ?? 100;
    this.windowSeconds = opts.windowSeconds ?? 60;
  }

  async check(input: RateLimitCheckInput): Promise<RateLimitDecision> {
    const bucketKey = `${input.tenantId ?? "anon"}|${input.principalId ?? "anon"}|${input.route?.operationId ?? "*"}`;
    const nowMs = input.now.getTime();
    let bucket = this.buckets.get(bucketKey);
    if (bucket === undefined || bucket.resetAtMs <= nowMs) {
      bucket = { count: 0, resetAtMs: nowMs + this.windowSeconds * 1000 };
      this.buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    const decisionId = `rld_${(++this.decisionCounter).toString().padStart(20, "0")}`;
    const remaining = Math.max(0, this.limit - bucket.count);
    const resetAt = new Date(bucket.resetAtMs).toISOString();
    if (bucket.count > this.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAtMs - nowMs) / 1000));
      return {
        allowed: false,
        retryAfterSeconds,
        decisionId,
        limit: this.limit,
        remaining: 0,
        resetAt,
        reason: "in_memory_window_exceeded",
      };
    }
    return {
      allowed: true,
      retryAfterSeconds: 0,
      decisionId,
      limit: this.limit,
      remaining,
      resetAt,
      reason: "within_limit",
    };
  }

  setLimitForKey(opts: { tenantId: string | null; principalId: string | null; operationId: string; count: number }): void {
    const bucketKey = `${opts.tenantId ?? "anon"}|${opts.principalId ?? "anon"}|${opts.operationId}`;
    this.buckets.set(bucketKey, { count: opts.count, resetAtMs: Date.now() + this.windowSeconds * 1000 });
  }
}

export class InMemoryRouteRegistry implements RouteRegistry {
  private readonly routes: Array<RouteDefinition & { readonly pathRegex: RegExp; readonly paramNames: readonly string[] }> = [];

  register(route: RouteDefinition): this {
    const { regex, paramNames } = compileRoutePattern(route);
    this.routes.push({ ...route, pathRegex: regex, paramNames });
    return this;
  }

  lookup(input: RouteLookupInput): RouteLookupResult | null {
    for (const route of this.routes) {
      if (route.method !== input.method) continue;
      if (route.apiVersion !== input.apiVersion) continue;
      const match = route.pathRegex.exec(input.path);
      if (match === null) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, idx) => {
        const v = match[idx + 1];
        if (v !== undefined) params[name] = v;
      });
      return { route, params };
    }
    return null;
  }

  listVersionsFor(method: IncomingRequest["method"], path: string): readonly string[] {
    const versions = new Set<string>();
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.pathRegex.test(path)) {
        versions.add(route.apiVersion);
      }
    }
    return [...versions];
  }
}

function compileRoutePattern(route: RouteDefinition): {
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
} {
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
  const regex = new RegExp(`^/${parts.join("/")}/?$`);
  return { regex, paramNames };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
