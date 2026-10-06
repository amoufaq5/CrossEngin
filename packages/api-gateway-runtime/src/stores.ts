import { randomBytes } from "node:crypto";

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

const DECISION_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * A per-instance prefix, because a counter alone is not an id.
 *
 * `rld_` + a zero-padded counter made **every** process mint `rld_…0001` first. Harmless while
 * nothing persisted a decision, and not harmless now: this is the checker `buildOperateGateway`
 * installs by default, `PipelineExecution.rateLimitDecisionId` carries whatever it minted, and
 * `PostgresPipelineExecutionStore` writes that column — so two replicas' executions would name one
 * decision and `GatewayReplayer.rate_limit_decision_not_found` would be unreliable in both
 * directions. The same defect `PostgresRateLimitChecker` was built with and fixed.
 *
 * Deliberately not `hostname():pid` the way a worker id is: that one exists so an operator can find
 * the process holding a lease, while this one has to be *unique*, and two containers can share a
 * hostname and a pid.
 */
function randomDecisionInstanceId(): string {
  let out = "";
  for (const byte of randomBytes(12)) out += DECISION_ALPHABET[byte & 0x1f];
  return out;
}

export class InMemoryRateLimitChecker implements RateLimitChecker {
  private readonly buckets: Map<string, { count: number; resetAtMs: number }> = new Map();
  private decisionCounter = 0;
  private readonly instanceId: string;
  private readonly limit: number;
  private readonly windowSeconds: number;

  constructor(
    opts: {
      readonly limit?: number;
      readonly windowSeconds?: number;
      /** Pinned by a test; a deployment never passes one. 12 lowercase alphanumerics. */
      readonly instanceId?: string;
    } = {},
  ) {
    this.limit = opts.limit ?? 100;
    this.windowSeconds = opts.windowSeconds ?? 60;
    const instanceId = opts.instanceId ?? randomDecisionInstanceId();
    if (!/^[a-z0-9]{12}$/.test(instanceId)) {
      throw new Error(`instanceId must be 12 lowercase alphanumeric characters, got ${JSON.stringify(instanceId)}`);
    }
    this.instanceId = instanceId;
  }

  private nextDecisionId(): string {
    this.decisionCounter += 1;
    let n = this.decisionCounter;
    let counter = "";
    while (counter.length < 8) {
      counter = DECISION_ALPHABET[n & 0x1f] + counter;
      n = n >>> 5;
    }
    return `rld_${this.instanceId}${counter}`;
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
    const decisionId = this.nextDecisionId();
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

  /**
   * Every registered route, so a caller surveying the served surface reads the registry rather than
   * a list it maintains by hand — `HandlerRegistry.operationIds()`'s reason (ADR-0334), on the other
   * half of the pair. Deliberately **not** on `RouteRegistry`: `PostgresRouteRegistry` answers
   * `lookup` from a TTL cache over a table, so enumerating it is a query with a different cost and a
   * different answer, and an interface method would make every implementor owe one.
   *
   * Registration order. The compiled `pathRegex`/`paramNames` are stripped, since they are this
   * class's own matching state and not part of the declaration.
   */
  list(): readonly RouteDefinition[] {
    return this.routes.map(({ pathRegex: _pathRegex, paramNames: _paramNames, ...route }) => route);
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
