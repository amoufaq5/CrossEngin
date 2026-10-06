import type {
  RateLimitCheckInput,
  RateLimitChecker,
  RateLimitDecision,
} from "@crossengin/api-gateway-runtime";
import { randomBytes } from "node:crypto";

import type { PgConnection } from "@crossengin/kernel-pg";

import { probeDecisionSchema, type DecisionSchemaProbe } from "./decision-schema-probe.js";
import { scopedWrite } from "./pipeline-execution-store.js";
import {
  resolvePolicyForRoute,
  type DeclaredRateLimitPolicy,
  type RateLimitPolicyDeclaration,
} from "./rate-limit-policy.js";

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

/** 12 Crockford characters = 60 bits, so two instances colliding is not a case worth handling. */
export const DECISION_INSTANCE_ID_LENGTH = 12;
const DECISION_COUNTER_LENGTH = 8;

/**
 * A per-instance prefix, because the counter alone is not an id.
 *
 * `rld_` + a zero-padded counter made **every** process mint `rld_…0001` first, and the row is
 * written `ON CONFLICT (decision_id) DO NOTHING` — so a second replica's decisions were silently
 * discarded, and `PipelineExecution.rateLimitDecisionId` pointed at *another replica's* decision,
 * which `GatewayReplayer` would then report as found. Reproduced live: three rows from the first
 * process, zero from the second, no error either time. Loss on one side and misattribution on the
 * other, from one missing piece of identity.
 *
 * Random rather than `hostname():pid` — which is ADR-0333's `claimed_by` precedent — because that
 * value exists for an operator to read off a row and answer "which process holds this lease", while
 * this one has to be *unique* and two containers can share a hostname and a pid.
 */
function randomInstanceId(): string {
  const bytes = randomBytes(DECISION_INSTANCE_ID_LENGTH);
  let out = "";
  for (const byte of bytes) out += CROCKFORD[byte & 0x1f];
  return out;
}

/** Why a decision row was not written. Reported, never thrown — see `persist`. */
export type DecisionPersistDefect = "schema_unready" | "statement_failed";

export interface DecisionPersistFailure {
  readonly defect: DecisionPersistDefect;
  readonly detail: string;
  readonly decisionId: string;
}

export interface UndeclaredPolicyReport {
  readonly policyId: string;
  readonly operationId: string | null;
}

export interface PostgresRateLimitCheckerOptions {
  readonly conn: PgConnection;
  /**
   * The deployment's policy declaration. Required, with no default: which limit a deployment
   * permits is not something silence may answer, and the old `limit`/`windowSeconds` pair recorded
   * nothing about *where* the limit came from, which is the defect this replaces.
   */
  readonly policies: RateLimitPolicyDeclaration;
  readonly persistDecisions?: boolean;
  readonly idSeed?: number;
  /**
   * This instance's share of the decision id — 12 Crockford characters, random per construction.
   * A caller supplies one only to make ids reproducible in a test.
   */
  readonly instanceId?: string;
  /**
   * Called when a decision could not be persisted. Defaults to `console.error`.
   *
   * It is a report and not a throw because `GatewayRuntime.handleRequest` runs its seventeen stages
   * in a bare loop with **no try/catch**: a rejection out of `rateLimitChecker.check` escapes the
   * whole pipeline, so there is no RFC 9457 problem document and no `PipelineExecution` — the
   * request simply disappears. Verified live: the shipped store, handed a resolvable principal,
   * raises `rate_limit_decisions_principal_id_fkey` on every call, which would have taken down
   * every request on the gateway rather than losing one audit row. The limit has already been
   * applied and the decision already returned; the row is a projection of it, and ADR-0333's rule
   * holds — a failed projection must not turn a successful enforcement into a failed request.
   */
  readonly onPersistFailure?: (failure: DecisionPersistFailure) => void;
  /** Called when a route names a policy the declaration does not carry. Defaults to `console.error`. */
  readonly onUndeclaredPolicy?: (report: UndeclaredPolicyReport) => void;
  /**
   * Pre-probed schema shape. Supplied by a caller that already surveyed at boot; otherwise the
   * first persisted decision probes once and the answer is reused for the process's life (a column
   * type does not change under a running server, and re-asking per request would add a round trip
   * to the request path).
   */
  readonly schema?: DecisionSchemaProbe;
}

interface WindowState {
  count: number;
  windowStartMs: number;
}

export class PostgresRateLimitChecker implements RateLimitChecker {
  private readonly conn: PgConnection;
  private readonly policies: RateLimitPolicyDeclaration;
  private readonly persistDecisions: boolean;
  private readonly onPersistFailure: (failure: DecisionPersistFailure) => void;
  private readonly onUndeclaredPolicy: (report: UndeclaredPolicyReport) => void;
  private readonly buckets: Map<string, WindowState> = new Map();
  private readonly instanceId: string;
  private decisionCounter: number;
  private schema: DecisionSchemaProbe | null;
  private schemaProbe: Promise<DecisionSchemaProbe> | null = null;
  private principalLossReported = false;

  constructor(opts: PostgresRateLimitCheckerOptions) {
    this.conn = opts.conn;
    this.policies = opts.policies;
    this.persistDecisions = opts.persistDecisions ?? true;
    this.decisionCounter = opts.idSeed ?? 0;
    const instanceId = opts.instanceId ?? randomInstanceId();
    if (!new RegExp(`^[a-z0-9]{${String(DECISION_INSTANCE_ID_LENGTH)}}$`).test(instanceId)) {
      throw new Error(
        `instanceId must be ${String(DECISION_INSTANCE_ID_LENGTH)} lowercase alphanumeric characters, got ${JSON.stringify(instanceId)}`,
      );
    }
    this.instanceId = instanceId;
    this.schema = opts.schema ?? null;
    this.onPersistFailure =
      opts.onPersistFailure ??
      ((failure) => {
        console.error(
          `[rate-limit] decision ${failure.decisionId} not persisted (${failure.defect}): ${failure.detail}`,
        );
      });
    this.onUndeclaredPolicy =
      opts.onUndeclaredPolicy ??
      ((report) => {
        console.error(
          `[rate-limit] route ${report.operationId ?? "<unmatched>"} names undeclared policy ${report.policyId}; request refused`,
        );
      });
  }

  async check(input: RateLimitCheckInput): Promise<RateLimitDecision> {
    const resolution = resolvePolicyForRoute(this.policies, input.route);
    if (resolution.kind === "undeclared") {
      // Fail closed, and write **no row**: `limit_total`, `remaining_after` and `reset_at` are all
      // `NOT NULL`, so every figure in the row would have to be invented for a policy whose terms
      // are not known. A fabricated figure in an audit row is worse than an absent row, and
      // `surveyRoutePolicies` makes this a boot-time finding rather than a per-request surprise.
      this.onUndeclaredPolicy({
        policyId: resolution.policyId,
        operationId: input.route?.operationId ?? null,
      });
      return {
        allowed: false,
        retryAfterSeconds: 0,
        decisionId: this.nextDecisionId(),
        limit: 0,
        remaining: 0,
        resetAt: input.now.toISOString(),
        reason: `policy_undeclared_${resolution.policyId}`,
      };
    }
    const policy = resolution.policy;
    const scopeKey = this.scopeKeyFor(input);
    // Keyed by policy as well as scope: a route moved from one policy to another must not inherit
    // the old policy's window, since the two carry different terms.
    const bucketKey = `${policy.policyId}|${scopeKey}`;
    const nowMs = input.now.getTime();
    let bucket = this.buckets.get(bucketKey);
    if (bucket === undefined || nowMs - bucket.windowStartMs >= policy.windowSeconds * 1000) {
      bucket = { count: 0, windowStartMs: nowMs };
      this.buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    const decisionId = this.nextDecisionId();
    const resetAt = new Date(bucket.windowStartMs + policy.windowSeconds * 1000).toISOString();
    const allowed = bucket.count <= policy.limit;
    const remaining = Math.max(0, policy.limit - bucket.count);
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(
          1,
          Math.ceil((bucket.windowStartMs + policy.windowSeconds * 1000 - nowMs) / 1000),
        );
    const decision: RateLimitDecision = {
      allowed,
      retryAfterSeconds,
      decisionId,
      limit: policy.limit,
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
        policy,
        decision,
        decidedAtIso: input.now.toISOString(),
      });
    }
    return decision;
  }

  /** Which policy a route resolves to, without deciding anything. For a boot survey and for tests. */
  policyFor(input: Pick<RateLimitCheckInput, "route">): DeclaredRateLimitPolicy | null {
    const resolution = resolvePolicyForRoute(this.policies, input.route);
    return resolution.kind === "undeclared" ? null : resolution.policy;
  }

  private scopeKeyFor(input: RateLimitCheckInput): string {
    const tenant = input.tenantId ?? "anonymous";
    const principal = input.principalId ?? "anonymous";
    const operation = input.route?.operationId ?? "*";
    return `${tenant}|${principal}|${operation}`;
  }

  private nextDecisionId(): string {
    this.decisionCounter += 1;
    // 12 + 8 = 20 characters, the same width the counter-only form produced, so the catalog's
    // `^rld_[a-z0-9]{8,40}$` check and anything reading the id by length are unaffected. The
    // counter wraps after 2^40 decisions in one process, which at 10k/s is 3.5 years.
    return `rld_${this.instanceId}${encodeBase32Lower(this.decisionCounter, DECISION_COUNTER_LENGTH)}`;
  }

  /** Probed once per process and memoised, including the in-flight promise so a burst probes once. */
  private async resolveSchema(): Promise<DecisionSchemaProbe> {
    if (this.schema !== null) return this.schema;
    this.schemaProbe ??= probeDecisionSchema(this.conn).then((probe) => {
      this.schema = probe;
      return probe;
    });
    try {
      return await this.schemaProbe;
    } catch (err) {
      // An unreachable catalog is not evidence either way, so nothing is memoised and the next
      // decision asks again.
      this.schemaProbe = null;
      throw err;
    }
  }

  private async persist(input: {
    readonly decisionId: string;
    readonly tenantId: string | null;
    readonly scopeKey: string;
    readonly principalId: string | null;
    readonly routeOperationId: string | null;
    readonly policy: DeclaredRateLimitPolicy;
    readonly decision: RateLimitDecision;
    readonly decidedAtIso: string;
  }): Promise<void> {
    let schema: DecisionSchemaProbe;
    try {
      schema = await this.resolveSchema();
    } catch (err) {
      this.onPersistFailure({
        defect: "statement_failed",
        detail: `schema probe failed: ${err instanceof Error ? err.message : String(err)}`,
        decisionId: input.decisionId,
      });
      return;
    }
    if (!schema.ready) {
      this.onPersistFailure({
        defect: "schema_unready",
        detail: `${schema.defects.join("; ")} — run: ${schema.remediationSql.join(" ")}`,
        decisionId: input.decisionId,
      });
      return;
    }
    // A `uuid` `principal_id` is survivable where a `uuid` `policy_id` is not: the row is written
    // with no principal and the loss is the attribution, said out loud once rather than per request.
    // ADR-0322's rule — a surface that degrades rather than refusing has to say so.
    let principalId = input.principalId;
    if (schema.principalColumn !== "text" && principalId !== null) {
      principalId = null;
      if (!this.principalLossReported) {
        this.principalLossReported = true;
        this.onPersistFailure({
          defect: "schema_unready",
          detail: `principal attribution dropped from every decision: ${schema.defects.join("; ")} — run: ${schema.remediationSql.join(" ")}`,
          decisionId: input.decisionId,
        });
      }
    }
    const outcome = input.decision.allowed
      ? "allowed"
      : input.decision.quotaExceeded === true
        ? "denied_quota_exceeded"
        : "denied_rate_limit_exceeded";
    try {
      await scopedWrite(this.conn, input.tenantId, (tx) =>
        tx.query(
          `INSERT INTO ${SCHEMA}.${DECISIONS_TABLE} (
             decision_id, tenant_id, policy_id, scope_key,
             principal_id, api_key_prefix, route, decided_at, outcome,
             cost_units, limit_total, remaining_after, reset_at,
             retry_after_seconds, soft_throttle_delay_ms,
             applied_headers, problem_details, bypass_reason
           )
           VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, 1, $9, $10, $11, $12, NULL, NULL, NULL, NULL)
           -- DO NOTHING is correct here and is pinned by a test, so nobody "completes" ADR-0333's
           -- sweep into it: a decision_id is minted per decision and never revisited, so the
           -- conflict means "write this once" rather than "advance this row". That is
           -- PostgresDrReadinessStore's case, not the failover store's.
           ON CONFLICT (decision_id) DO NOTHING`,
          [
            input.decisionId,
            input.tenantId,
            input.policy.policyId,
            input.scopeKey,
            principalId,
            input.routeOperationId,
            input.decidedAtIso,
            outcome,
            input.decision.limit,
            input.decision.remaining,
            input.decision.resetAt,
            input.decision.allowed ? null : input.decision.retryAfterSeconds,
          ],
        ),
      );
    } catch (err) {
      this.onPersistFailure({
        defect: "statement_failed",
        detail: err instanceof Error ? err.message : String(err),
        decisionId: input.decisionId,
      });
    }
  }
}
