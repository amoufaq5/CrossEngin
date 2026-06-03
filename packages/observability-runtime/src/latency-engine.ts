import {
  type Slo,
  type SloLatencyTarget,
} from "@crossengin/observability";
import type { AlertPolicy } from "@crossengin/observability";
import type { IncidentCategory, Severity } from "@crossengin/incident-response";
import { SystemClock, parseDurationMs, type Clock } from "./clock.js";
import { RollingWindow, type RequestOutcome } from "./window.js";
import {
  DEFAULT_LATENCY_THRESHOLDS,
  evaluateLatencyTarget,
  type LatencyThreshold,
  type LatencyVerdict,
} from "./latency.js";
import {
  formatIncidentId,
  formatKillSwitchId,
  planIncidentDeclaration,
  planKillSwitchActivation,
  planPageDirective,
  type EnforcementPlan,
  type FlagRollback,
} from "./enforcement.js";

export interface LatencyRegistration {
  readonly slo: Slo;
  readonly category?: IncidentCategory;
  readonly rollback?: FlagRollback;
  readonly tenantId?: string | null;
}

export interface LatencySloEngineOptions {
  readonly alertPolicy: AlertPolicy;
  readonly systemActorUserId: string;
  readonly registrations: readonly LatencyRegistration[];
  readonly thresholds?: readonly LatencyThreshold[];
  readonly clock?: Clock;
  readonly declaredBy?: string;
  readonly window?: RollingWindow;
  readonly latencyWindow?: string;
}

interface ActiveBreach {
  readonly incidentId: string;
  readonly killSwitchId: string | null;
  readonly severity: Severity;
}

export type LatencyEnforcementDecision =
  | {
      readonly kind: "breach_opened";
      readonly surface: string;
      readonly sloId: string;
      readonly severity: Severity;
      readonly verdict: LatencyVerdict;
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

function latencyTarget(slo: Slo): SloLatencyTarget | null {
  return (
    slo.targets.find((t): t is SloLatencyTarget => t.kind === "latency") ?? null
  );
}

export class LatencySloEngine {
  private readonly window: RollingWindow;
  private readonly clock: Clock;
  private readonly registrations: readonly LatencyRegistration[];
  private readonly thresholds: readonly LatencyThreshold[];
  private readonly alertPolicy: AlertPolicy;
  private readonly systemActorUserId: string;
  private readonly declaredBy: string;
  private readonly latencyWindowMs: number;
  private readonly active: Map<string, ActiveBreach> = new Map();
  private incidentSeq = 0;
  private killSwitchSeq = 0;

  constructor(options: LatencySloEngineOptions) {
    this.alertPolicy = options.alertPolicy;
    this.systemActorUserId = options.systemActorUserId;
    this.registrations = options.registrations;
    this.thresholds = options.thresholds ?? DEFAULT_LATENCY_THRESHOLDS;
    this.clock = options.clock ?? new SystemClock();
    this.declaredBy = options.declaredBy ?? "system-slo-enforcer";
    this.window = options.window ?? new RollingWindow();
    this.latencyWindowMs = parseDurationMs(options.latencyWindow ?? "5m");
  }

  recordOutcome(outcome: RequestOutcome): void {
    this.window.record(outcome);
  }

  activeBreaches(): readonly { surface: string; breach: ActiveBreach }[] {
    return [...this.active.entries()].map(([surface, breach]) => ({ surface, breach }));
  }

  evaluate(now: Date = this.clock.now()): readonly LatencyEnforcementDecision[] {
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const decisions: LatencyEnforcementDecision[] = [];

    for (const reg of this.registrations) {
      const target = latencyTarget(reg.slo);
      if (target === null) continue;
      const surface = reg.slo.surface;
      const observed = this.window.latencyStats(surface, this.latencyWindowMs, nowMs);
      const verdict = evaluateLatencyTarget(target, observed, this.thresholds);
      const existing = this.active.get(surface);

      if (verdict.breached && existing === undefined) {
        decisions.push(this.openBreach(reg, surface, verdict, nowIso));
      } else if (verdict.breached && existing !== undefined) {
        decisions.push({
          kind: "breach_ongoing",
          surface,
          sloId: reg.slo.id,
          incidentId: existing.incidentId,
        });
      } else if (!verdict.breached && existing !== undefined) {
        this.active.delete(surface);
        decisions.push({
          kind: "recovered",
          surface,
          sloId: reg.slo.id,
          incidentId: existing.incidentId,
          killSwitchId: existing.killSwitchId,
        });
      }
    }

    return decisions;
  }

  private openBreach(
    reg: LatencyRegistration,
    surface: string,
    verdict: LatencyVerdict,
    nowIso: string,
  ): LatencyEnforcementDecision {
    const severity = verdict.worstSeverity as Severity;
    const year = new Date(nowIso).getUTCFullYear();
    this.incidentSeq += 1;
    const incidentId = formatIncidentId(year, this.incidentSeq);

    const worst = verdict.breaches.find(
      (b) => b.severity === severity && b.percentile === verdict.worstPercentile,
    );
    const detail =
      worst !== undefined
        ? `${worst.percentile} ${Math.round(worst.observedMs)}ms exceeds budget ${Math.round(worst.budgetMs)}ms (x${worst.multiplier} → ${Math.round(worst.thresholdMs)}ms)`
        : "latency budget breached";

    const incident = planIncidentDeclaration({
      incidentId,
      title: `Latency SLO breach: ${reg.slo.id} on ${surface}`,
      severity,
      category: reg.category ?? "performance",
      surface,
      nowIso,
      declaredBy: this.declaredBy,
      detail: `Auto-declared by latency enforcement (${verdict.worstThresholdId}): ${detail}.`,
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
        justification: `Latency enforcement rolled ${reg.rollback.flagId} back to its safe value after a ${verdict.worstThresholdId} breach on ${surface}.`,
      });
    }

    this.active.set(surface, { incidentId, killSwitchId, severity });

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
