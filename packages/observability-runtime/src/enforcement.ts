import { z } from "zod";
import {
  IncidentRecordSchema,
  type IncidentRecord,
  type IncidentCategory,
  type Severity,
} from "@crossengin/incident-response";
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

export function formatIncidentId(year: number, seq: number): string {
  if (!Number.isInteger(year) || year < 1970) throw new Error("invalid year");
  if (!Number.isInteger(seq) || seq < 0) throw new Error("invalid sequence");
  return `INC-${year}-${String(seq).padStart(4, "0")}`;
}

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
