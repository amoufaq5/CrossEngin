import {
  type Slo,
  type SloAvailabilityTarget,
} from "@crossengin/observability";
import type { AlertPolicy } from "@crossengin/observability";
import type { IncidentCategory, Severity } from "@crossengin/incident-response";
import { SystemClock, type Clock } from "./clock.js";
import { RollingWindow, type RequestOutcome } from "./window.js";
import {
  DEFAULT_BURN_RATE_THRESHOLDS,
  evaluateBurnRate,
  type BurnRateThreshold,
  type BurnRateVerdict,
} from "./burn-rate.js";
import {
  formatIncidentId,
  formatKillSwitchId,
  planIncidentDeclaration,
  planKillSwitchActivation,
  planPageDirective,
  type EnforcementPlan,
  type FlagRollback,
} from "./enforcement.js";

export interface SloRegistration {
  readonly slo: Slo;
  readonly category?: IncidentCategory;
  readonly rollback?: FlagRollback;
  readonly tenantId?: string | null;
}

export interface SloEnforcementEngineOptions {
  readonly alertPolicy: AlertPolicy;
  readonly systemActorUserId: string;
  readonly registrations: readonly SloRegistration[];
  readonly thresholds?: readonly BurnRateThreshold[];
  readonly clock?: Clock;
  readonly declaredBy?: string;
  readonly window?: RollingWindow;
}

interface ActiveBreach {
  readonly incidentId: string;
  readonly killSwitchId: string | null;
  readonly severity: Severity;
  readonly thresholdId: string;
}

export type EnforcementDecision =
  | {
      readonly kind: "breach_opened";
      readonly surface: string;
      readonly sloId: string;
      readonly severity: Severity;
      readonly verdict: BurnRateVerdict;
      readonly plan: EnforcementPlan;
    }
  | {
      readonly kind: "breach_ongoing";
      readonly surface: string;
      readonly sloId: string;
      readonly incidentId: string;
    }
  | {
      readonly kind: "recovered";
      readonly surface: string;
      readonly sloId: string;
      readonly incidentId: string;
      readonly killSwitchId: string | null;
    };

function availabilityTarget(slo: Slo): SloAvailabilityTarget | null {
  return (
    slo.targets.find(
      (t): t is SloAvailabilityTarget => t.kind === "availability",
    ) ?? null
  );
}

export class SloEnforcementEngine {
  private readonly window: RollingWindow;
  private readonly clock: Clock;
  private readonly registrations: readonly SloRegistration[];
  private readonly thresholds: readonly BurnRateThreshold[];
  private readonly alertPolicy: AlertPolicy;
  private readonly systemActorUserId: string;
  private readonly declaredBy: string;
  private readonly active: Map<string, ActiveBreach> = new Map();
  private incidentSeq = 0;
  private killSwitchSeq = 0;

  constructor(options: SloEnforcementEngineOptions) {
    this.alertPolicy = options.alertPolicy;
    this.systemActorUserId = options.systemActorUserId;
    this.registrations = options.registrations;
    this.thresholds = options.thresholds ?? DEFAULT_BURN_RATE_THRESHOLDS;
    this.clock = options.clock ?? new SystemClock();
    this.declaredBy = options.declaredBy ?? "system-slo-enforcer";
    this.window = options.window ?? new RollingWindow();
  }

  recordOutcome(outcome: RequestOutcome): void {
    this.window.record(outcome);
  }

  activeBreaches(): readonly { surface: string; breach: ActiveBreach }[] {
    return [...this.active.entries()].map(([surface, breach]) => ({ surface, breach }));
  }

  evaluate(now: Date = this.clock.now()): readonly EnforcementDecision[] {
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const decisions: EnforcementDecision[] = [];

    for (const reg of this.registrations) {
      const { slo } = reg;
      const target = availabilityTarget(slo);
      if (target === null) continue;
      const surface = slo.surface;
      const verdict = evaluateBurnRate(
        target.target,
        (windowMs) => this.window.count(surface, windowMs, nowMs),
        this.thresholds,
      );
      const existing = this.active.get(surface);

      if (verdict.breached && existing === undefined) {
        decisions.push(this.openBreach(reg, surface, verdict, nowIso));
      } else if (verdict.breached && existing !== undefined) {
        decisions.push({
          kind: "breach_ongoing",
          surface,
          sloId: slo.id,
          incidentId: existing.incidentId,
        });
      } else if (!verdict.breached && existing !== undefined) {
        this.active.delete(surface);
        decisions.push({
          kind: "recovered",
          surface,
          sloId: slo.id,
          incidentId: existing.incidentId,
          killSwitchId: existing.killSwitchId,
        });
      }
    }

    return decisions;
  }

  private openBreach(
    reg: SloRegistration,
    surface: string,
    verdict: BurnRateVerdict,
    nowIso: string,
  ): EnforcementDecision {
    const severity = verdict.worstSeverity as Severity;
    const thresholdId = verdict.worstThresholdId as string;
    const year = new Date(nowIso).getUTCFullYear();
    this.incidentSeq += 1;
    const incidentId = formatIncidentId(year, this.incidentSeq);

    const worst = verdict.evaluations.find((e) => e.threshold.id === thresholdId);
    const burnDetail =
      worst !== undefined
        ? `burn ${worst.longBurn.toFixed(1)}x over ${worst.threshold.longWindow} / ${worst.shortBurn.toFixed(1)}x over ${worst.threshold.shortWindow}`
        : "burn threshold breached";

    const incident = planIncidentDeclaration({
      incidentId,
      title: `SLO burn alert: ${reg.slo.id} on ${surface}`,
      severity,
      category: reg.category,
      surface,
      nowIso,
      declaredBy: this.declaredBy,
      detail: `Auto-declared by SLO enforcement (${thresholdId}): ${burnDetail}.`,
    });

    const page = planPageDirective(this.alertPolicy, severity, incidentId);
    const pages = page === null ? [] : [page];

    let killSwitch: EnforcementPlan["killSwitch"] = null;
    let killSwitchId: string | null = null;
    if (reg.rollback !== undefined) {
      this.killSwitchSeq += 1;
      killSwitchId = formatKillSwitchId(this.killSwitchSeq);
      killSwitch = planKillSwitchActivation({
        killSwitchId,
        flagId: reg.rollback.flagId,
        safeValueJson: reg.rollback.safeValueJson,
        tenantId: reg.tenantId ?? null,
        systemActorUserId: this.systemActorUserId,
        incidentId,
        nowIso,
        justification: `SLO enforcement rolled ${reg.rollback.flagId} back to its safe value after ${thresholdId} burn on ${surface}.`,
      });
    }

    this.active.set(surface, { incidentId, killSwitchId, severity, thresholdId });

    return {
      kind: "breach_opened",
      surface,
      sloId: reg.slo.id,
      severity,
      verdict,
      plan: { incident, pages, killSwitch },
    };
  }
}
