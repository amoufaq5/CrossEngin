import type {
  RateLimitCheckInput,
  RateLimitChecker,
  RateLimitDecision,
} from "@crossengin/api-gateway-runtime";
import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA = "meta";
const DECISIONS_TABLE = "rate_limit_decisions";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

function encodeBase32Lower(input: number, length: number): string {
  let n = input;
  let out = "";
  while (out.length < length) {
    out = CROCKFORD[n & 0x1f] + out;
    n = n >>> 5;
  }
  return out;
}

export interface PostgresRateLimitCheckerOptions {
  readonly conn: PgConnection;
  readonly limit: number;
  readonly windowSeconds: number;
  readonly persistDecisions?: boolean;
  readonly idSeed?: number;
}

interface WindowState {
  count: number;
  windowStartMs: number;
}

export class PostgresRateLimitChecker implements RateLimitChecker {
  private readonly conn: PgConnection;
  private readonly limit: number;
  private readonly windowSeconds: number;
  private readonly persistDecisions: boolean;
  private readonly buckets: Map<string, WindowState> = new Map();
  private decisionCounter: number;

  constructor(opts: PostgresRateLimitCheckerOptions) {
    if (opts.limit < 1) throw new Error(`limit must be >= 1, got ${opts.limit.toString()}`);
    if (opts.windowSeconds < 1) {
      throw new Error(`windowSeconds must be >= 1, got ${opts.windowSeconds.toString()}`);
    }
    this.conn = opts.conn;
    this.limit = opts.limit;
    this.windowSeconds = opts.windowSeconds;
    this.persistDecisions = opts.persistDecisions ?? true;
    this.decisionCounter = opts.idSeed ?? 0;
  }

  async check(input: RateLimitCheckInput): Promise<RateLimitDecision> {
    const scopeKey = this.scopeKeyFor(input);
    const nowMs = input.now.getTime();
    let bucket = this.buckets.get(scopeKey);
    if (bucket === undefined || nowMs - bucket.windowStartMs >= this.windowSeconds * 1000) {
      bucket = { count: 0, windowStartMs: nowMs };
      this.buckets.set(scopeKey, bucket);
    }
    bucket.count += 1;
    const decisionId = this.nextDecisionId();
    const resetAt = new Date(bucket.windowStartMs + this.windowSeconds * 1000).toISOString();
    const allowed = bucket.count <= this.limit;
    const remaining = Math.max(0, this.limit - bucket.count);
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(1, Math.ceil((bucket.windowStartMs + this.windowSeconds * 1000 - nowMs) / 1000));
    const decision: RateLimitDecision = {
      allowed,
      retryAfterSeconds,
      decisionId,
      limit: this.limit,
      remaining,
      resetAt,
      reason: allowed ? "within_limit" : "window_exceeded",
    };
    if (this.persistDecisions) {
      await this.persist({
        decisionId,
        tenantId: input.tenantId,
        scopeKey,
        principalId: input.principalId,
        routeOperationId: input.route?.operationId ?? null,
        decision,
        decidedAtIso: input.now.toISOString(),
      });
    }
    return decision;
  }

  private scopeKeyFor(input: RateLimitCheckInput): string {
    const tenant = input.tenantId ?? "anonymous";
    const principal = input.principalId ?? "anonymous";
    const operation = input.route?.operationId ?? "*";
    return `${tenant}|${principal}|${operation}`;
  }

  private nextDecisionId(): string {
    this.decisionCounter += 1;
    const padded = encodeBase32Lower(this.decisionCounter, 20);
    return `rld_${padded}`;
  }

  private async persist(input: {
    readonly decisionId: string;
    readonly tenantId: string | null;
    readonly scopeKey: string;
    readonly principalId: string | null;
    readonly routeOperationId: string | null;
    readonly decision: RateLimitDecision;
    readonly decidedAtIso: string;
  }): Promise<void> {
    const outcome = input.decision.allowed
      ? "allowed"
      : input.decision.quotaExceeded === true
        ? "denied_quota_exceeded"
        : "denied_rate_limit_exceeded";
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${DECISIONS_TABLE} (
         decision_id, tenant_id, policy_id, quota_definition_id, scope_key,
         principal_id, api_key_prefix, route, decided_at, outcome,
         cost_units, limit_total, remaining_after, reset_at,
         retry_after_seconds, soft_throttle_delay_ms,
         applied_headers, problem_details, bypass_reason
       )
       VALUES ($1, $2, NULL, NULL, $3, $4, NULL, $5, $6, $7, 1, $8, $9, $10, $11, NULL, NULL, NULL, NULL)
       ON CONFLICT (decision_id) DO NOTHING`,
      [
        input.decisionId,
        input.tenantId,
        input.scopeKey,
        input.principalId,
        input.routeOperationId,
        input.decidedAtIso,
        outcome,
        input.decision.limit,
        input.decision.remaining,
        input.decision.resetAt,
        input.decision.allowed ? null : input.decision.retryAfterSeconds,
      ],
    );
  }
}
