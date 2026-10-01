import { z } from "zod";
import {
  IncidentRecordSchema,
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

export function formatKillSwitchId(seq: number): string {
  if (!Number.isInteger(seq) || seq < 0) throw new Error("invalid sequence");
  return `fks_auto${String(seq).padStart(8, "0")}`;
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

/** Which surface's declaration failed, and at which end of the incident's life. */
export interface DeclarationFailure {
  readonly surface: string;
  readonly sloId: string;
  readonly phase: "find_open" | "declare" | "close_out" | "find_kill_switch";
}

/**
 * Where an adopted breach's kill switch comes from.
 *
 * The engine activates a kill switch when it opens a breach, but it holds the id in memory, so a
 * restart that adopts the incident has no idea which flag was rolled back — and the operator is left
 * with a flag held at its safe value and nothing naming it. Structural on purpose: the Postgres
 * implementation lives beside the store, and the engine must not depend on it.
 */
export interface KillSwitchLookup {
  findForIncident(incidentId: string): Promise<string | null>;
}

/**
 * The kill switch an adopted incident rolled a flag back with, or null.
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
    impactScopeNotes: `Auto-rollback triggered by SLO enforcement for incident ${input.incidentId}.`,
  });
}

export interface EnforcementPlan {
  readonly incident: IncidentRecord;
  readonly pages: readonly PageDirective[];
  readonly killSwitch: KillSwitch | null;
}
