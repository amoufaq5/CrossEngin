import { z } from "zod";
import {
  IncidentRecordSchema,
  SEVERITIES,
  SeveritySchema,
  parseIncidentId,
  type IncidentRecord,
  type IncidentCategory,
  type Severity,
} from "@crossengin/incident-response";
import type {
  IncidentCloseOut,
  IncidentDeclarationRequest,
  IncidentDeclarer,
} from "@crossengin/incident-response-runtime";
import {
  resolveRoute,
  type AlertPolicy,
  type AlertChannelTarget,
  type Severity as AlertSeverity,
} from "@crossengin/observability";
import { KillSwitchSchema, type KillSwitch } from "@crossengin/feature-flags";

export const SEVERITY_TO_ALERT_SEVERITY: Readonly<Record<Severity, AlertSeverity>> =
  Object.freeze({
    sev1: "P0",
    sev2: "P1",
    sev3: "P2",
    sev4: "P3",
    sev5: "P3",
  });

export function alertSeverityFor(severity: Severity): AlertSeverity {
  return SEVERITY_TO_ALERT_SEVERITY[severity];
}

// Re-exported, not redefined: the formatter belongs with the pattern it must satisfy, which
// lives in the contracts package alongside `IncidentRecordSchema`.
export { formatIncidentId } from "@crossengin/incident-response";

/**
 * A counter-derived kill-switch id. Kept for a caller that mints its own, but **not** used by the
 * engines: the counter restarts with the process, and now that a kill switch is stored that reissues
 * an id the unique constraint already holds. See `killSwitchIdForIncident`.
 */
export function formatKillSwitchId(seq: number): string {
  if (!Number.isInteger(seq) || seq < 0) throw new Error("invalid sequence");
  return `fks_auto${String(seq).padStart(8, "0")}`;
}

/**
 * The kill-switch id for the incident whose breach activated it.
 *
 * Derived from the incident id rather than counted, because the incident id is already unique and
 * already allocated by whoever stores it (ADR-0293) — so this inherits that uniqueness instead of
 * re-inventing it. Measured: a counter here reissued `fks_auto00000001` from a second engine
 * instance, the insert was refused by `feature_flag_kill_switches_kill_switch_id_key`, and the
 * failure arrived *after* the incident had been declared — leaving a declared incident with no
 * enforcement action naming it. One episode records one switch, so one id per incident is the right
 * granularity as well as the safe one.
 */
export function killSwitchIdForIncident(incidentId: string): string {
  const { year, sequence } = parseIncidentId(incidentId);
  return `fks_${String(year)}${String(sequence).padStart(4, "0")}`;
}

export const FlagRollbackSchema = z
  .object({
    flagId: z.string().regex(/^ff_[a-z0-9]{8,32}$/),
    safeValueJson: z.string().min(1).max(10_000),
  })
  .strict()
  .superRefine((v, ctx) => {
    try {
      JSON.parse(v.safeValueJson);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["safeValueJson"],
        message: "safeValueJson must be valid JSON",
      });
    }
  });
export type FlagRollback = z.infer<typeof FlagRollbackSchema>;

export interface IncidentDeclarationInput {
  readonly incidentId: string;
  /** The signal this declaration is the incident for; see `autoDeclaredForKey`. */
  readonly autoDeclaredFor?: string;
  readonly title: string;
  readonly severity: Severity;
  readonly category?: IncidentCategory;
  readonly surface: string;
  readonly nowIso: string;
  readonly declaredBy: string;
  readonly affectedTenantIds?: readonly string[];
  readonly detail: string;
}

export function planIncidentDeclaration(input: IncidentDeclarationInput): IncidentRecord {
  return IncidentRecordSchema.parse({
    id: input.incidentId,
    autoDeclaredFor: input.autoDeclaredFor ?? null,
    title: input.title,
    severity: input.severity,
    category: input.category ?? "availability",
    status: "declared",
    affectedTenantIds: input.affectedTenantIds ?? [],
    declaredAt: input.nowIso,
    declaredBy: input.declaredBy,
    timeline: [
      {
        occurredAt: input.nowIso,
        actorUserId: input.declaredBy,
        kind: "declared",
        message: input.detail,
        metadata: { surface: input.surface, autoDeclared: true },
      },
    ],
  });
}

/**
 * The steps of an enforcement pass a failure can be reported from, rather than thrown out of it.
 *
 * Every phase after `declare` happens to an incident that already exists, so a throw there would
 * cost the page for a declared incident: the engine has already remembered the breach as active,
 * and the next pass answers `breach_ongoing` with no pages. A rollback, its kill switch, and the
 * persisted projections are all worth less than the page, so each is reported and given up.
 */
export type EnforcementFailurePhase =
  | "find_open"
  | "declare"
  | "close_out"
  | "find_kill_switch"
  | "plan_kill_switch"
  | "record_kill_switch"
  | "release_kill_switch"
  | "regrade"
  | "deliver_pages"
  | "record_enforcement_action"
  | "record_evaluation";

/** Which surface's enforcement step failed, and which step. */
export interface DeclarationFailure {
  readonly surface: string;
  readonly sloId: string;
  readonly phase: EnforcementFailurePhase;
}

/**
 * Where an adopted breach's kill switch comes from.
 *
 * The engine records a kill switch when it opens a breach, but it holds the id in memory, so a
 * restart that adopts the incident has no idea which switch it recorded. Structural on purpose: the
 * Postgres implementation lives beside the store, and the engine must not depend on it.
 */
export interface KillSwitchLookup {
  findForIncident(incidentId: string): Promise<string | null>;
}

/**
 * The kill switch recorded for an adopted incident, or null.
 *
 * A failed lookup is reported and read as "none recorded". The alternative — refusing to adopt
 * because the kill switch could not be read — would re-declare the incident over a detail that is
 * reported rather than acted on, which trades a real problem for a cosmetic one.
 */
export async function findAdoptedKillSwitch(
  lookup: KillSwitchLookup | undefined,
  incidentId: string,
  failure: Omit<DeclarationFailure, "phase">,
  onError?: DeclarationErrorSink,
): Promise<string | null> {
  if (lookup === undefined) return null;
  try {
    return await lookup.findForIncident(incidentId);
  } catch (err) {
    onError?.(err, { ...failure, phase: "find_kill_switch" });
    return null;
  }
}

export type DeclarationErrorSink = (error: unknown, failure: DeclarationFailure) => void;

/**
 * The same declaration `planIncidentDeclaration` builds, handed to a declarer that chooses the id.
 *
 * Pinned by a test to produce the record `planIncidentDeclaration` produces for the same inputs:
 * an auto-declared incident must not look different depending on whether its id came from a
 * counter or from the rows that exist.
 */
export function enforcementDeclarationRequest(
  input: Omit<IncidentDeclarationInput, "incidentId">,
): IncidentDeclarationRequest {
  return {
    title: input.title,
    severity: input.severity,
    category: input.category ?? "availability",
    declaredBy: input.declaredBy,
    detail: input.detail,
    declaredAt: input.nowIso,
    affectedTenantIds: input.affectedTenantIds ?? [],
    metadata: { surface: input.surface, autoDeclared: true },
    ...(input.autoDeclaredFor !== undefined ? { autoDeclaredFor: input.autoDeclaredFor } : {}),
  };
}

/**
 * The open incident this signal already declared, if any.
 *
 * Called before declaring, so a process that restarted mid-breach adopts the incident it opened
 * before rather than declaring a second for the same still-present breach. A lookup that fails is
 * reported and read as "nothing open": that risks a duplicate incident, never a missed one, and
 * `idx_incidents_auto_declared_open` refuses the duplicate anyway.
 */
export async function findOpenEnforcementIncident(
  declarer: IncidentDeclarer,
  autoDeclaredFor: string,
  failure: Omit<DeclarationFailure, "phase">,
  onError?: DeclarationErrorSink,
): Promise<IncidentRecord | null> {
  try {
    return await declarer.findOpen(autoDeclaredFor);
  } catch (err) {
    onError?.(err, { ...failure, phase: "find_open" });
    return null;
  }
}

/**
 * Declares through the injected declarer, reporting a failure instead of throwing.
 *
 * A declaration that could not be recorded leaves the breach unopened, so the next evaluation tick
 * retries it. Throwing instead would abandon every surface after this one in the same pass — one
 * unreachable store would hide every other breach, which is worse than a page delayed by a tick.
 */
export async function declareEnforcementIncident(
  declarer: IncidentDeclarer,
  input: Omit<IncidentDeclarationInput, "incidentId">,
  failure: Omit<DeclarationFailure, "phase">,
  onError?: DeclarationErrorSink,
): Promise<IncidentRecord | null> {
  try {
    return await declarer.declare(enforcementDeclarationRequest(input));
  } catch (err) {
    onError?.(err, { ...failure, phase: "declare" });
    return null;
  }
}

export interface EnforcementCloseOutInput {
  readonly reason: string;
  readonly actorUserId: string;
  readonly at: string;
}

/**
 * Closes out a recovered breach's incident, reporting `failed` rather than throwing.
 *
 * The breach is no longer active either way — refusing to forget it would leave the engine
 * reporting `breach_ongoing` for a surface that recovered. A `failed` close-out means the row stays
 * open, where `listOpen` surfaces it for a human.
 */
export async function closeOutEnforcementIncident(
  declarer: IncidentDeclarer,
  incidentId: string,
  input: EnforcementCloseOutInput,
  failure: Omit<DeclarationFailure, "phase">,
  onError?: DeclarationErrorSink,
): Promise<IncidentCloseOut> {
  try {
    return await declarer.closeOut(incidentId, input);
  } catch (err) {
    onError?.(err, { ...failure, phase: "close_out" });
    return "failed";
  }
}

export interface PageDirective {
  readonly severity: Severity;
  readonly alertSeverity: AlertSeverity;
  readonly channels: readonly AlertChannelTarget[];
  readonly incidentId: string;
}

export function planPageDirective(
  policy: AlertPolicy,
  severity: Severity,
  incidentId: string,
): PageDirective | null {
  const alertSeverity = alertSeverityFor(severity);
  const route = resolveRoute(policy, alertSeverity);
  if (route === null) return null;
  return { severity, alertSeverity, channels: route.channels, incidentId };
}

export interface KillSwitchActivationInput {
  readonly killSwitchId: string;
  readonly flagId: string;
  readonly safeValueJson: string;
  readonly tenantId: string | null;
  readonly systemActorUserId: string;
  readonly incidentId: string;
  readonly nowIso: string;
  readonly justification: string;
  readonly expiresAtIso?: string | null;
}

/**
 * A kill switch built for a declared incident. `justification` and `impactScopeNotes` are written
 * once and kept for as long as the row is, so they say only what happened when it was written:
 * nothing in this workspace applies a kill switch to a flag (`KILL_SWITCH_ENFORCEMENT_GAP`), and a
 * sentence claiming the flag was rolled back — or claiming that nothing applies the row — would be
 * false on some day of that row's life.
 */
export function planKillSwitchActivation(input: KillSwitchActivationInput): KillSwitch {
  return KillSwitchSchema.parse({
    id: input.killSwitchId,
    tenantId: input.tenantId,
    flagId: input.flagId,
    status: "triggered_active",
    triggerKind: "automated_metric_breach",
    justification: input.justification,
    armedAt: input.nowIso,
    armedByUserId: input.systemActorUserId,
    triggeredAt: input.nowIso,
    triggeredByUserId: input.systemActorUserId,
    coTriggeredByUserId: null,
    coTriggeredAt: null,
    expiresAt: input.expiresAtIso ?? null,
    releasedAt: null,
    releasedByUserId: null,
    releasedReason: null,
    expiredAt: null,
    relatedIncidentId: input.incidentId,
    overriddenValueJson: input.safeValueJson,
    impactScopeNotes: `Kill switch recorded by SLO enforcement for incident ${input.incidentId}.`,
  });
}

/**
 * Where a planned kill switch is stored. Structural for `KillSwitchLookup`'s reason, and called by
 * the engine itself rather than after it returns, so a switch that could not be stored is never
 * remembered as the breach's switch — a later recovery would otherwise name an id with no row
 * behind it.
 */
export interface KillSwitchRecorder {
  record(killSwitch: KillSwitch): Promise<void>;
}

/** A rollback the registration declared and for which no kill switch was recorded. */
export interface UnrecordedKillSwitch {
  readonly flagId: string;
  readonly phase: Extract<EnforcementFailurePhase, "plan_kill_switch" | "record_kill_switch">;
}

export interface KillSwitchActivation {
  /** The switch, planned — and stored, when a recorder was given. Null when none was. */
  readonly killSwitch: KillSwitch | null;
  /** Non-null exactly when a rollback was declared and `killSwitch` is null. */
  readonly unrecorded: UnrecordedKillSwitch | null;
}

/**
 * Plans the declared rollback's kill switch and stores it, reporting either failure rather than
 * throwing.
 *
 * Runs after the incident is declared, so a throw here would cost that incident its page: the
 * plan's parse refuses, for one, a registration `tenantId` that is not a UUID, which a registration
 * with no rollback is never asked to be. The failure is carried on the plan as `unrecorded` so the
 * decision says a rollback was declared and nothing was recorded, which a null switch alone cannot
 * tell apart from no rollback at all.
 */
export async function activateKillSwitch(
  input: KillSwitchActivationInput,
  recorder: KillSwitchRecorder | undefined,
  failure: Omit<DeclarationFailure, "phase">,
  onError?: DeclarationErrorSink,
): Promise<KillSwitchActivation> {
  let killSwitch: KillSwitch;
  try {
    killSwitch = planKillSwitchActivation(input);
  } catch (err) {
    onError?.(err, { ...failure, phase: "plan_kill_switch" });
    return { killSwitch: null, unrecorded: { flagId: input.flagId, phase: "plan_kill_switch" } };
  }
  if (recorder !== undefined) {
    try {
      await recorder.record(killSwitch);
    } catch (err) {
      onError?.(err, { ...failure, phase: "record_kill_switch" });
      return {
        killSwitch: null,
        unrecorded: { flagId: input.flagId, phase: "record_kill_switch" },
      };
    }
  }
  return { killSwitch, unrecorded: null };
}

export interface EnforcementPlan {
  readonly incident: IncidentRecord;
  readonly pages: readonly PageDirective[];
  readonly killSwitch: KillSwitch | null;
  /** See `KillSwitchActivation.unrecorded`. Null when no rollback was declared or it was recorded. */
  readonly killSwitchUnrecorded: UnrecordedKillSwitch | null;
}

// ---------------------------------------------------------------------------
// Escalating a breach that persists (M-23)
// ---------------------------------------------------------------------------

/**
 * A registration's declared escalation: a breach still burning `afterMs` after it was declared is
 * re-graded to `severity` and re-paged at that grade, once per episode. Opt-in per registration,
 * because what grade a long burn deserves is a judgement about the surface; with none, an ongoing
 * breach pages once, as before.
 */
export const BreachEscalationSchema = z
  .object({
    afterMs: z.number().int().min(60_000),
    severity: SeveritySchema,
  })
  .strict();
export type BreachEscalation = z.infer<typeof BreachEscalationSchema>;

/** Lower is graver: `sev1` is 1. */
export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity) + 1;
}

/**
 * Whether an open breach is due its escalation now. Never for a breach already at or above the
 * declared grade — an escalation that would lower or keep the grade is not one — and never twice
 * for one episode.
 */
export function escalationDue(
  escalation: BreachEscalation | undefined,
  breach: { readonly severity: Severity; readonly openedAtMs: number; readonly escalated: boolean },
  nowMs: number,
): escalation is BreachEscalation {
  if (escalation === undefined || breach.escalated) return false;
  if (severityRank(escalation.severity) >= severityRank(breach.severity)) return false;
  return nowMs - breach.openedAtMs >= escalation.afterMs;
}

export interface IncidentRegradeInput {
  readonly severity: Severity;
  readonly reason: string;
  readonly actorUserId: string;
  readonly at: string;
}

/**
 * Re-grades a stored incident. Structural for `KillSwitchLookup`'s reason: the Postgres
 * implementation is `PersistentIncidentEngine.changeSeverity`, which the engine must not depend on.
 */
export interface IncidentRegrader {
  regrade(incidentId: string, input: IncidentRegradeInput): Promise<void>;
}

/**
 * Re-grades through the regrader, reporting a failure instead of throwing. The re-page goes out
 * either way: the page is what wakes somebody, and a record left at the old grade is a projection
 * worth less than that (ADR-0415's rule). Answers whether the record was re-graded.
 */
export async function regradeEnforcementIncident(
  regrader: IncidentRegrader | undefined,
  incidentId: string,
  input: IncidentRegradeInput,
  failure: Omit<DeclarationFailure, "phase">,
  onError?: DeclarationErrorSink,
): Promise<boolean> {
  if (regrader === undefined) return false;
  try {
    await regrader.regrade(incidentId, input);
    return true;
  } catch (err) {
    onError?.(err, { ...failure, phase: "regrade" });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Releasing a kill switch on recovery (ADR-0415)
// ---------------------------------------------------------------------------

/**
 * How long a kill switch SLO enforcement records stays `triggered_active` if nothing releases it.
 * A backstop and not the mechanism: the engine releases its switch when the breach recovers. It is
 * there for the switch whose recovery this process never saw — a breach still open when the process
 * stopped and never adopted again — which otherwise stays active for ever.
 */
export const DEFAULT_KILL_SWITCH_TTL_MS = 24 * 60 * 60 * 1000;

export interface KillSwitchReleaseInput {
  readonly reason: string;
  readonly actorUserId: string;
  readonly at: string;
}

/**
 * Releases a recovered breach's kill switch. Answers `true` when this call released it and `false`
 * when there was nothing active to release (already released or expired by its TTL).
 */
export interface KillSwitchReleaser {
  release(
    killSwitchId: string,
    tenantId: string | null,
    input: KillSwitchReleaseInput,
  ): Promise<boolean>;
}

/**
 * What became of a recovered breach's kill switch: `released` by this recovery, `not_active` when
 * it had already been released or had lapsed, `no_releaser` when nothing here can release it (the
 * in-memory engine), `failed` when the release was reported rather than made, and `none` when the
 * breach recorded no switch.
 */
export type KillSwitchRelease = "released" | "not_active" | "no_releaser" | "failed" | "none";

export async function releaseRecoveredKillSwitch(
  releaser: KillSwitchReleaser | undefined,
  killSwitchId: string | null,
  tenantId: string | null,
  input: KillSwitchReleaseInput,
  failure: Omit<DeclarationFailure, "phase">,
  onError?: DeclarationErrorSink,
): Promise<KillSwitchRelease> {
  if (killSwitchId === null) return "none";
  if (releaser === undefined) return "no_releaser";
  try {
    return (await releaser.release(killSwitchId, tenantId, input)) ? "released" : "not_active";
  } catch (err) {
    onError?.(err, { ...failure, phase: "release_kill_switch" });
    return "failed";
  }
}
