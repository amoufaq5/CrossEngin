import { randomBytes } from "node:crypto";
import { z } from "zod";
import { SeveritySchema } from "@crossengin/incident-response";
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
    occurredAt: Iso8601,
  })
  .strict();
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
