import { readFile } from "node:fs/promises";

import { z } from "zod";
import type { PgConnection } from "@crossengin/kernel-pg";
import type { IncidentDeclarer } from "@crossengin/incident-response-runtime";
import { PostgresIncidentDeclarer } from "@crossengin/incident-response-runtime-pg";
import { AlertPolicySchema, SloSchema, type AlertPolicy } from "@crossengin/observability";
import {
  FlagRollbackSchema,
  LatencySloEngine,
  SloEnforcementEngine,
  type Clock,
  type EnforcementDecision,
  type LatencyEnforcementDecision,
  planPageDirective,
  type LatencyRegistration,
  type PageDirective,
  type SloRegistration,
} from "@crossengin/observability-runtime";
import {
  buildPersistentLatencySloEngine,
  buildPersistentSloEnforcementEngine,
} from "@crossengin/observability-runtime-pg";

import type { IntervalScheduler } from "./jwks.js";
import {
  SloEvaluationScheduler,
  SloRequestObserver,
  availabilityEvaluator,
  latencyEvaluator,
  type DecisionEvaluator,
  type DecisionSource,
  type ObservedEnforcementDecision,
  type OutcomeRecorder,
} from "./slo.js";

const DEFAULT_EVALUATE_INTERVAL_MS = 60_000;

export const SloRegistrationConfigSchema = z
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

export type SloRegistrationConfig = z.infer<typeof SloRegistrationConfigSchema>;

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
  /** Delivers the pages a decision planned. Awaited by the scheduler (ADR-0326). */
  readonly onPage?: (decision: ObservedEnforcementDecision) => Promise<void>;
  /**
   * Closes the alerts a recovered breach's page opened, over the directives that were actually
   * delivered — the scheduler remembers them, because a recovery has no plan to re-derive from
   * (ADR-0326).
   */
  readonly onResolvePage?: (
    decision: ObservedEnforcementDecision,
    pages: readonly PageDirective[],
  ) => Promise<void>;
  /**
   * Recovers what to resolve for an episode this process did not page — a breach that spanned a
   * restart (ADR-0327). Defaulted below from the declarer and the config's own alert policy, which
   * is the only pair that can answer without guessing a grade.
   */
  readonly recoverPages?: (
    decision: ObservedEnforcementDecision,
  ) => Promise<readonly PageDirective[]>;
  readonly onError?: (err: unknown) => void;
  /**
   * With a connection the engines persist: each evaluation, each enforcement action, and the
   * declared `IncidentRecord` itself, whose id is allocated from the stored rows. Without one they
   * run in memory and mint ids from a per-process counter, which restarts at `INC-YYYY-0001`.
   */
  readonly conn?: PgConnection;
  /** Overrides where ids come from — one declarer shared with anything else that declares. */
  readonly declarer?: IncidentDeclarer;
}

export interface SloEnforcement {
  readonly observer: SloRequestObserver;
  readonly scheduler: SloEvaluationScheduler;
  readonly engines: {
    readonly availability: SloEnforcementEngine | null;
    readonly latency: LatencySloEngine | null;
  };
  /** True when the engines write their evaluations, actions and incidents to Postgres. */
  readonly persisted: boolean;
}

/**
 * Builds the live SLO enforcement wiring from a config: an availability engine
 * (from `config.availability`) and/or a latency engine (from `config.latency`),
 * an `SloRequestObserver` that feeds every request outcome into whichever
 * engines exist, and an `SloEvaluationScheduler` that drives their `evaluate()`
 * on an interval. The observer's execution sink plugs into
 * `OperateHttpServerOptions.onExecution`; the scheduler is `start()`ed by the
 * caller.
 *
 * With `opts.conn` the engines are wrapped in their persisting builders, so a breach leaves three
 * rows — the evaluation, the enforcement action, and the declared incident — and both engines
 * allocate ids from one store, so a burn breach and a latency breach can never be handed the same
 * `INC-YYYY-NNNN`.
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

  // One declarer for both engines: ids come from a single sequence in the database, so the two
  // signals cannot name the same incident.
  const declarer =
    opts.declarer ??
    (opts.conn !== undefined ? new PostgresIncidentDeclarer({ conn: opts.conn }) : undefined);
  const declarerOpt = declarer !== undefined ? { declarer } : {};

  const availabilityOptions = {
    alertPolicy: config.alertPolicy,
    systemActorUserId: config.systemActorUserId,
    registrations: availabilityRegs,
    ...clockOpt,
    ...declarerOpt,
  };
  const latencyOptions = {
    alertPolicy: config.alertPolicy,
    systemActorUserId: config.systemActorUserId,
    registrations: latencyRegs,
    ...clockOpt,
    ...declarerOpt,
  };

  let availability: SloEnforcementEngine | null = null;
  let availabilitySource: DecisionSource<EnforcementDecision> | null = null;
  if (availabilityRegs.length > 0) {
    if (opts.conn !== undefined) {
      const persistent = buildPersistentSloEnforcementEngine(opts.conn, availabilityOptions);
      availability = persistent.engine;
      availabilitySource = persistent;
    } else {
      availability = new SloEnforcementEngine(availabilityOptions);
      availabilitySource = availability;
    }
  }

  let latency: LatencySloEngine | null = null;
  let latencySource: DecisionSource<LatencyEnforcementDecision> | null = null;
  if (latencyRegs.length > 0) {
    if (opts.conn !== undefined) {
      const persistent = buildPersistentLatencySloEngine(opts.conn, latencyOptions);
      latency = persistent.engine;
      latencySource = persistent;
    } else {
      latency = new LatencySloEngine(latencyOptions);
      latencySource = latency;
    }
  }

  const recorders: OutcomeRecorder[] = [];
  if (availability !== null) recorders.push(availability);
  if (latency !== null) recorders.push(latency);

  const evaluators: DecisionEvaluator[] = [];
  if (availabilitySource !== null) evaluators.push(availabilityEvaluator(availabilitySource));
  if (latencySource !== null) evaluators.push(latencyEvaluator(latencySource));

  const observer = new SloRequestObserver({ recorders });
  const scheduler = new SloEvaluationScheduler({
    evaluators,
    intervalMs: config.evaluateIntervalMs ?? DEFAULT_EVALUATE_INTERVAL_MS,
    ...(opts.scheduler !== undefined ? { scheduler: opts.scheduler } : {}),
    ...(opts.onDecision !== undefined ? { onDecision: opts.onDecision } : {}),
    ...(opts.onPage !== undefined ? { onPage: opts.onPage } : {}),
    ...(opts.onResolvePage !== undefined ? { onResolvePage: opts.onResolvePage } : {}),
    // Defaulted rather than required: a deployment that wires `onResolvePage` gets restart-safe
    // resolution without asking for it, and one with no store gets a recovery that answers `[]`.
    recoverPages: opts.recoverPages ?? defaultRecoverPages(config.alertPolicy, declarer),
    ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
  });

  return {
    observer,
    scheduler,
    engines: { availability, latency },
    persisted: opts.conn !== undefined,
  };
}

/**
 * Asks the incident store what grade an episode was declared at, and plans a resolve from it.
 *
 * This is the restart case ADR-0326 left open. ADR-0326's rule is that a resolve must reach exactly
 * where its trigger did, because `AlertPolicy` maps a severity to a channel set — so the grade is
 * the route, and the only non-guessing source for the grade of an incident this process did not
 * declare is the stored record. `findById` is that read.
 *
 * Three ways to answer "nothing to resolve", all of them the fail-closed outcome — the alert is left
 * up for a human rather than closed somewhere nobody was woken:
 *
 * - **no declarer** (no `--store pg`): ids came from a per-process counter and name no row at all.
 * - **no `findById`**: the seam is optional, and absent means the same as null by contract.
 * - **null**: no stored incident holds that id.
 *
 * A throw is a fourth, and deliberately **not** caught here: `PostgresIncidentDeclarer.findById`
 * throws only for a row that exists and no longer parses (ADR-0289), which is a tampered or
 * corrupted record. Planning a page's closure from a record the contract rejects is worse than
 * failing the pass, and `evaluateOnce` already routes the failure to `onError`.
 */
export function defaultRecoverPages(
  alertPolicy: AlertPolicy,
  declarer: IncidentDeclarer | undefined,
): (decision: ObservedEnforcementDecision) => Promise<readonly PageDirective[]> {
  return async (decision): Promise<readonly PageDirective[]> => {
    const incidentId = decision.incidentId;
    if (incidentId === null || declarer?.findById === undefined) return [];
    const record = await declarer.findById(incidentId);
    if (record === null) return [];
    // The record's own severity, never the decision's — a `recovered` decision carries none, which
    // is the whole reason this function exists.
    const directive = planPageDirective(alertPolicy, record.severity, record.id);
    return directive === null ? [] : [directive];
  };
}
