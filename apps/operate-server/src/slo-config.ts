import { readFile } from "node:fs/promises";

import { z } from "zod";
import { AlertPolicySchema, SloSchema } from "@crossengin/observability";
import {
  FlagRollbackSchema,
  LatencySloEngine,
  SloEnforcementEngine,
  type Clock,
  type LatencyRegistration,
  type SloRegistration,
} from "@crossengin/observability-runtime";

import type { IntervalScheduler } from "./jwks.js";
import {
  SloEvaluationScheduler,
  SloRequestObserver,
  availabilityEvaluator,
  latencyEvaluator,
  type DecisionEvaluator,
  type ObservedEnforcementDecision,
  type OutcomeRecorder,
} from "./slo.js";

const DEFAULT_EVALUATE_INTERVAL_MS = 60_000;

const SloRegistrationConfigSchema = z
  .object({
    slo: SloSchema,
    category: z.string().min(1).optional(),
    rollback: FlagRollbackSchema.optional(),
    tenantId: z.string().min(1).nullable().optional(),
  })
  .strict();

/**
 * A JSON SLO enforcement config for a running `operate-server`: the alert policy
 * + the acting system user, plus the availability and/or latency SLOs to
 * enforce over the live request stream. At least one of `availability` /
 * `latency` must carry a registration — an empty config would silently enforce
 * nothing.
 */
export const SloConfigSchema = z
  .object({
    alertPolicy: AlertPolicySchema,
    systemActorUserId: z.string().uuid(),
    evaluateIntervalMs: z.number().int().positive().optional(),
    availability: z.array(SloRegistrationConfigSchema).optional(),
    latency: z.array(SloRegistrationConfigSchema).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const count = (v.availability?.length ?? 0) + (v.latency?.length ?? 0);
    if (count === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one of availability/latency must contain an SLO registration",
      });
    }
  });

export type SloConfig = z.infer<typeof SloConfigSchema>;

type SloRegistrationConfig = z.infer<typeof SloRegistrationConfigSchema>;

/** Pure parse — validates an already-decoded JSON value into a `SloConfig`. */
export function parseSloConfig(json: unknown): SloConfig {
  return SloConfigSchema.parse(json);
}

/** Reads + JSON-parses + validates an SLO config file. */
export async function loadSloConfig(path: string): Promise<SloConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    throw new Error(`failed to read SLO config ${path}: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    throw new Error(`SLO config ${path} is not valid JSON: ${detail}`);
  }
  return parseSloConfig(parsed);
}

function toRegistration(config: SloRegistrationConfig): SloRegistration {
  return {
    slo: config.slo,
    // `category` is a free string in the file; the engine narrows it to an
    // IncidentCategory (an invalid value fails the incident schema at declaration).
    ...(config.category !== undefined
      ? { category: config.category as SloRegistration["category"] }
      : {}),
    ...(config.rollback !== undefined ? { rollback: config.rollback } : {}),
    ...(config.tenantId !== undefined ? { tenantId: config.tenantId } : {}),
  };
}

export interface BuildSloEnforcementOptions {
  readonly clock?: Clock;
  readonly scheduler?: IntervalScheduler;
  readonly onDecision?: (decision: ObservedEnforcementDecision) => void;
  readonly onError?: (err: unknown) => void;
}

export interface SloEnforcement {
  readonly observer: SloRequestObserver;
  readonly scheduler: SloEvaluationScheduler;
  readonly engines: {
    readonly availability: SloEnforcementEngine | null;
    readonly latency: LatencySloEngine | null;
  };
}

/**
 * Builds the live SLO enforcement wiring from a config: an availability engine
 * (from `config.availability`) and/or a latency engine (from `config.latency`),
 * an `SloRequestObserver` that feeds every request outcome into whichever
 * engines exist, and an `SloEvaluationScheduler` that drives their `evaluate()`
 * on an interval. The observer's execution sink plugs into
 * `OperateHttpServerOptions.onExecution`; the scheduler is `start()`ed by the
 * caller.
 */
export function buildSloEnforcement(
  config: SloConfig,
  opts: BuildSloEnforcementOptions = {},
): SloEnforcement {
  const clockOpt = opts.clock !== undefined ? { clock: opts.clock } : {};
  const availabilityRegs = (config.availability ?? []).map(toRegistration);
  const latencyRegs = (config.latency ?? []).map(
    (r): LatencyRegistration => toRegistration(r),
  );

  const availability =
    availabilityRegs.length > 0
      ? new SloEnforcementEngine({
          alertPolicy: config.alertPolicy,
          systemActorUserId: config.systemActorUserId,
          registrations: availabilityRegs,
          ...clockOpt,
        })
      : null;
  const latency =
    latencyRegs.length > 0
      ? new LatencySloEngine({
          alertPolicy: config.alertPolicy,
          systemActorUserId: config.systemActorUserId,
          registrations: latencyRegs,
          ...clockOpt,
        })
      : null;

  const recorders: OutcomeRecorder[] = [];
  if (availability !== null) recorders.push(availability);
  if (latency !== null) recorders.push(latency);

  const evaluators: DecisionEvaluator[] = [];
  if (availability !== null) evaluators.push(availabilityEvaluator(availability));
  if (latency !== null) evaluators.push(latencyEvaluator(latency));

  const observer = new SloRequestObserver({ recorders });
  const scheduler = new SloEvaluationScheduler({
    evaluators,
    intervalMs: config.evaluateIntervalMs ?? DEFAULT_EVALUATE_INTERVAL_MS,
    ...(opts.scheduler !== undefined ? { scheduler: opts.scheduler } : {}),
    ...(opts.onDecision !== undefined ? { onDecision: opts.onDecision } : {}),
    ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
  });

  return { observer, scheduler, engines: { availability, latency } };
}
