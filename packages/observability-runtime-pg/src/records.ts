import { randomBytes } from "node:crypto";
import { z } from "zod";
import { setPlatformWriteSql, type PgConnection } from "@crossengin/kernel-pg";
import { SeveritySchema } from "@crossengin/incident-response";
import { INCIDENT_CLOSE_OUTS } from "@crossengin/incident-response-runtime";
import type {
  BurnRateVerdict,
  EnforcementDecision,
  LatencyEnforcementDecision,
  LatencyVerdict,
} from "@crossengin/observability-runtime";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

function encodeBase32Lower(bytes: Uint8Array, length: number): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      bits -= 5;
      out += CROCKFORD[(buffer >> bits) & 0x1f];
    }
  }
  while (out.length < length) {
    out += CROCKFORD[(buffer << (5 - bits)) & 0x1f];
    bits = 0;
  }
  return out.slice(0, length);
}

export function generateEvaluationId(): string {
  return `sloe_${encodeBase32Lower(new Uint8Array(randomBytes(20)), 24)}`;
}

export function generateEnforcementActionId(): string {
  return `sloa_${encodeBase32Lower(new Uint8Array(randomBytes(20)), 24)}`;
}

export function generateLatencyEvaluationId(): string {
  return `slle_${encodeBase32Lower(new Uint8Array(randomBytes(20)), 24)}`;
}

export const SLO_SIGNALS = ["availability", "latency"] as const;
export type SloSignal = (typeof SLO_SIGNALS)[number];

const Iso8601 = z.string().datetime({ offset: true });

export const SloEvaluationRecordSchema = z
  .object({
    evaluationId: z.string().regex(/^sloe_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    sloId: z.string().min(1),
    surface: z.string().min(1),
    breached: z.boolean(),
    worstSeverity: SeveritySchema.nullable(),
    worstThresholdId: z.string().min(1).nullable(),
    target: z.number().gt(0).lte(1),
    evaluations: z.array(z.unknown()),
    evaluatedAt: Iso8601,
  })
  .strict();
export type SloEvaluationRecord = z.infer<typeof SloEvaluationRecordSchema>;

export const SLO_ENFORCEMENT_DECISIONS = [
  "breach_opened",
  "breach_ongoing",
  "recovered",
] as const;

export const SloEnforcementActionRecordSchema = z
  .object({
    actionId: z.string().regex(/^sloa_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    sloId: z.string().min(1),
    surface: z.string().min(1),
    signal: z.enum(SLO_SIGNALS).default("availability"),
    decision: z.enum(SLO_ENFORCEMENT_DECISIONS),
    severity: SeveritySchema.nullable(),
    incidentId: z.string().regex(/^INC-\d{4}-\d{4,8}$/),
    killSwitchId: z.string().regex(/^fks_[a-z0-9]{8,40}$/).nullable(),
    flagId: z.string().regex(/^ff_[a-z0-9]{8,32}$/).nullable(),
    paged: z.boolean(),
    pageChannelCount: z.number().int().nonnegative(),
    thresholdId: z.string().min(1).nullable(),
    // The close-out vocabulary belongs to the declarer that produces it; a second copy here would
    // drift from it. Omitted reads as null, which is the shape every non-recovery row has.
    closeOut: z.enum(INCIDENT_CLOSE_OUTS).nullable().default(null),
    occurredAt: Iso8601,
  })
  .strict()
  // Null means "this row is not a recovery", never "the recovery's outcome is unknown". Only a
  // `recovered` decision has something to close out, so either side of that is a contradiction and
  // refused — otherwise the column answers "was the recovery clean?" with a shrug.
  .superRefine((value, ctx) => {
    if (value.decision === "recovered" && value.closeOut === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closeOut"],
        message: "a recovered action must record what became of the incident",
      });
      return;
    }
    if (value.decision !== "recovered" && value.closeOut !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closeOut"],
        message: `closeOut belongs only to a recovered action, not ${value.decision}`,
      });
    }
  });
export type SloEnforcementActionRecord = z.infer<
  typeof SloEnforcementActionRecordSchema
>;

export interface EvaluationRecordInput {
  readonly sloId: string;
  readonly surface: string;
  readonly tenantId: string | null;
  readonly target: number;
  readonly verdict: BurnRateVerdict;
  readonly evaluatedAt: string;
  readonly evaluationId?: string;
}

export function evaluationRecordFromVerdict(
  input: EvaluationRecordInput,
): SloEvaluationRecord {
  return SloEvaluationRecordSchema.parse({
    evaluationId: input.evaluationId ?? generateEvaluationId(),
    tenantId: input.tenantId,
    sloId: input.sloId,
    surface: input.surface,
    breached: input.verdict.breached,
    worstSeverity: input.verdict.worstSeverity,
    worstThresholdId: input.verdict.worstThresholdId,
    target: input.target,
    evaluations: [...input.verdict.evaluations],
    evaluatedAt: input.evaluatedAt,
  });
}

export interface EnforcementActionInput {
  readonly decision: EnforcementDecision | LatencyEnforcementDecision;
  readonly tenantId: string | null;
  readonly occurredAt: string;
  readonly signal?: SloSignal;
  readonly thresholdId?: string | null;
  readonly actionId?: string;
}

export function enforcementActionFromDecision(
  input: EnforcementActionInput,
): SloEnforcementActionRecord {
  const { decision } = input;
  const base = {
    actionId: input.actionId ?? generateEnforcementActionId(),
    tenantId: input.tenantId,
    sloId: decision.sloId,
    surface: decision.surface,
    signal: input.signal ?? "availability",
    decision: decision.kind,
    occurredAt: input.occurredAt,
    thresholdId: input.thresholdId ?? null,
    closeOut: null,
  };

  if (decision.kind === "breach_opened") {
    const channelCount = decision.plan.pages.reduce(
      (sum, page) => sum + page.channels.length,
      0,
    );
    return SloEnforcementActionRecordSchema.parse({
      ...base,
      severity: decision.severity,
      incidentId: decision.plan.incident.id,
      killSwitchId: decision.plan.killSwitch?.id ?? null,
      flagId: decision.plan.killSwitch?.flagId ?? null,
      paged: decision.plan.pages.length > 0,
      pageChannelCount: channelCount,
      thresholdId: input.thresholdId ?? decision.verdict.worstThresholdId,
    });
  }

  if (decision.kind === "recovered") {
    return SloEnforcementActionRecordSchema.parse({
      ...base,
      severity: null,
      incidentId: decision.incidentId,
      killSwitchId: decision.killSwitchId,
      flagId: null,
      paged: false,
      pageChannelCount: 0,
      closeOut: decision.closeOut,
    });
  }

  return SloEnforcementActionRecordSchema.parse({
    ...base,
    severity: null,
    incidentId: decision.incidentId,
    killSwitchId: null,
    flagId: null,
    paged: false,
    pageChannelCount: 0,
  });
}

export const LATENCY_PERCENTILES = ["p50", "p95", "p99"] as const;

export const SloLatencyEvaluationRecordSchema = z
  .object({
    evaluationId: z.string().regex(/^slle_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    sloId: z.string().min(1),
    surface: z.string().min(1),
    breached: z.boolean(),
    worstSeverity: SeveritySchema.nullable(),
    worstThresholdId: z.string().min(1).nullable(),
    worstPercentile: z.enum(LATENCY_PERCENTILES).nullable(),
    sampleCount: z.number().int().nonnegative(),
    breaches: z.array(z.unknown()),
    evaluatedAt: Iso8601,
  })
  .strict();
export type SloLatencyEvaluationRecord = z.infer<
  typeof SloLatencyEvaluationRecordSchema
>;

export interface LatencyEvaluationRecordInput {
  readonly sloId: string;
  readonly surface: string;
  readonly tenantId: string | null;
  readonly verdict: LatencyVerdict;
  readonly evaluatedAt: string;
  readonly evaluationId?: string;
}

export function latencyEvaluationRecordFromVerdict(
  input: LatencyEvaluationRecordInput,
): SloLatencyEvaluationRecord {
  return SloLatencyEvaluationRecordSchema.parse({
    evaluationId: input.evaluationId ?? generateLatencyEvaluationId(),
    tenantId: input.tenantId,
    sloId: input.sloId,
    surface: input.surface,
    breached: input.verdict.breached,
    worstSeverity: input.verdict.worstSeverity,
    worstThresholdId: input.verdict.worstThresholdId,
    worstPercentile: input.verdict.worstPercentile,
    sampleCount: input.verdict.sampleCount,
    breaches: [...input.verdict.breaches],
    evaluatedAt: input.evaluatedAt,
  });
}

/**
 * The two session settings a scoped **write** needs, and the wrapper that picks exactly one.
 *
 * Until the policy split these stores set nothing at all, which worked only because a table's owner
 * bypasses its policies. As a non-owner the single `ALL`-scope policy admitted a platform row
 * (`tenant_id IS NULL` satisfied its `WITH CHECK` unconditionally — the defect) and refused a
 * tenant row outright, because with no context `current_setting('app.current_tenant_id', true)`
 * answers NULL or `''` and the comparison is never true. So both arms are needed: the platform one
 * because the split now demands a grant, and the tenant one because nothing ever supplied a context
 * for a row the store had always been able to write as the owner.
 *
 * Reads were left unwrapped when this comment was written, on the ground that scoping them is "a
 * separate change about owner-independence". That change is `scopeFilter` + `scopedRead` below.
 */
export const SET_TENANT_CONTEXT_SQL =
  "SELECT set_config('app.current_tenant_id', $1, true)";

export const SET_PLATFORM_RECORD_WRITE_SQL = setPlatformWriteSql("record");

const TENANT_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`invalid tenantId for RLS context: ${JSON.stringify(tenantId)}`);
  }
}

/** A `tenant_id` predicate and the parameters it binds, for one scope. */
export interface ScopeFilter {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * The `tenant_id` predicate a scoped read must carry, **beside** RLS rather than instead of it.
 *
 * All three tables here are `tenant_id`-nullable with a `SELECT`-scoped platform read arm, and **a
 * table's owner bypasses its policies** (ADR-0331), so an unscoped read answers from every scope in
 * a deployment that connects as the owner and from the platform's alone in one that does not. These
 * reads are nearly all aggregates, which is the sharp case — the caller gets a plausible scalar, not
 * a visibly long list. Measured live with two tenant breach rows beside one platform row on the same
 * `slo_id`: `countBreachesSince` answered **3** as the owner and **1** as a non-owner, so a burn-rate
 * input driving an incident declaration was off by a factor of three in the direction that pages.
 *
 * The predicate **branches** rather than using `tenant_id IS NOT DISTINCT FROM $1`, the one operator
 * matching NULL to NULL: ADR-0331 measured it at 16 ms sequential scan against 45k entries where
 * `tenant_id = $1` is a 0.09 ms index scan, because it is not indexable. `tenant_id IS NULL` is, so
 * both arms keep `idx_slo_evaluations_tenant_at` and its siblings.
 *
 * Verbatim from `forensics-pg`'s `scopeFilter`; it belongs in `kernel-pg` beside
 * `setPlatformWriteSql`, which this module already imports.
 */
export function scopeFilter(tenantId: string | null, firstParam = 1): ScopeFilter {
  // `tenant_id = NULL` is never true, so the platform scope has to be asked for as `IS NULL`.
  if (tenantId === null) return { sql: "tenant_id IS NULL", params: [] };
  assertTenantId(tenantId);
  return { sql: `tenant_id = $${String(firstParam)}`, params: [tenantId] };
}

/**
 * A **read**'s scope: a tenant context, or nothing at all.
 *
 * Nothing for the platform scope, because the platform read arm is `SELECT`-scoped on
 * `tenant_id IS NULL` and demands no grant. A read does not claim the write elevation: it does not
 * need it, and a privilege claimed for no reason is one the next statement in the same transaction
 * inherits.
 */
export async function scopedRead<T>(
  conn: PgConnection,
  tenantId: string | null,
  fn: (tx: PgConnection) => Promise<T>,
): Promise<T> {
  if (tenantId !== null) assertTenantId(tenantId);
  return conn.transaction(async (tx) => {
    if (tenantId !== null) await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
    return fn(tx);
  });
}

// `async` rather than returning `conn.transaction(...)` directly, so a rejected tenant id arrives
// as a rejection like every other failure here. A synchronous throw out of a `Promise`-returning
// function is a trap for a caller that only writes `.catch`.
export async function scopedWrite<T>(
  conn: PgConnection,
  tenantId: string | null,
  fn: (tx: PgConnection) => Promise<T>,
): Promise<T> {
  if (tenantId !== null) assertTenantId(tenantId);
  return conn.transaction(async (tx) => {
    if (tenantId === null) await tx.query(SET_PLATFORM_RECORD_WRITE_SQL);
    else await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
    return fn(tx);
  });
}
