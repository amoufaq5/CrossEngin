import type {
  RateLimitCheckInput,
  RateLimitChecker,
  RateLimitDecision,
} from "@crossengin/api-gateway-runtime";
import type { PgConnection } from "@crossengin/kernel-pg";
import { createHash, randomUUID } from "node:crypto";

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

export class PostgresRateLimitChecker implements RateLimitChecker {
  private readonly conn: PgConnection;
  private readonly limit: number;
  private readonly windowSeconds: number;
  private readonly persistDecisions: boolean;
  private decisionCounter: number;
  private readonly deterministicIds: boolean;

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
    this.deterministicIds = opts.idSeed !== undefined;
  }

  async check(input: RateLimitCheckInput): Promise<RateLimitDecision> {
    return this.checkHashedScope(this.scopeKeyFor(input), input.now, input);
  }

  /** Counts attempts before authentication. The scope is hashed before storage. */
  async checkScope(scope: string, now: Date): Promise<RateLimitDecision> {
    return this.checkHashedScope(`preauth|${scope}`, now);
  }

  private async checkHashedScope(scopeKey: string, now: Date, audit?: RateLimitCheckInput): Promise<RateLimitDecision> {
    const nowMs = now.getTime();
    const windowMs = this.windowSeconds * 1000;
    const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
    const windowStart = new Date(windowStartMs).toISOString();
    const proposedResetAt = new Date(windowStartMs + windowMs).toISOString();
    const scopeHash = createHash("sha256").update(scopeKey).digest("hex");
    const execute = async (tx: PgConnection): Promise<RateLimitDecision> => {
      const incremented = await tx.query<{ request_count: string | number; window_start: string | Date }>(
        `INSERT INTO meta.operate_rate_limit_buckets
           (scope_hash, window_start, request_count, expires_at, updated_at)
         VALUES ($1, $2, 1, $3, $4)
         ON CONFLICT (scope_hash) DO UPDATE SET
           request_count = CASE
             WHEN operate_rate_limit_buckets.window_start < EXCLUDED.window_start
             THEN 1 ELSE operate_rate_limit_buckets.request_count + 1 END,
           window_start = GREATEST(operate_rate_limit_buckets.window_start, EXCLUDED.window_start),
           expires_at = GREATEST(operate_rate_limit_buckets.expires_at, EXCLUDED.expires_at),
           updated_at = GREATEST(operate_rate_limit_buckets.updated_at, EXCLUDED.updated_at)
         RETURNING request_count, window_start`,
        [scopeHash, windowStart, proposedResetAt, now.toISOString()],
      );
      const count = Number(incremented.rows[0]?.request_count ?? 1);
      const effectiveWindowStartMs = Date.parse(String(incremented.rows[0]?.window_start ?? windowStart));
      const resetAt = new Date(effectiveWindowStartMs + windowMs).toISOString();
      const decisionId = this.nextDecisionId();
      const allowed = count <= this.limit;
      const remaining = Math.max(0, this.limit - count);
      const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((effectiveWindowStartMs + windowMs - nowMs) / 1000));
      const decision: RateLimitDecision = {
        allowed,
        retryAfterSeconds,
        decisionId,
        limit: this.limit,
        remaining,
        resetAt,
        reason: allowed ? "within_limit" : "window_exceeded",
      };
      if (this.persistDecisions && audit !== undefined) {
        if (audit.tenantId !== null) {
          await tx.query("SELECT set_config('app.current_tenant_id', $1, true)", [audit.tenantId]);
        }
        await this.persist(tx, {
          decisionId,
          tenantId: audit.tenantId,
          scopeKey,
          principalId: audit.principalId,
          routeOperationId: audit.route?.operationId ?? null,
          decision,
          decidedAtIso: now.toISOString(),
        });
      }
      return decision;
    };
    // The counter UPSERT is atomic by itself. Avoid BEGIN/COMMIT round trips on
    // the default production path; use a transaction only when audit persistence
    // must commit together with the counter update.
    return this.persistDecisions && audit !== undefined ? this.conn.transaction(execute) : execute(this.conn);
  }

  private scopeKeyFor(input: RateLimitCheckInput): string {
    const tenant = input.tenantId ?? "anonymous";
    const principal = input.principalId ?? "anonymous";
    const operation = input.route?.operationId ?? "*";
    return `${tenant}|${principal}|${operation}`;
  }

  private nextDecisionId(): string {
    if (!this.deterministicIds) return `rld_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    this.decisionCounter += 1;
    const padded = encodeBase32Lower(this.decisionCounter, 20);
    return `rld_${padded}`;
  }

  private async persist(conn: PgConnection, input: {
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
    await conn.query(
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
