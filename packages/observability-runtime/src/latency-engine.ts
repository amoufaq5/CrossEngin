import {
  type Slo,
  type SloLatencyTarget,
} from "@crossengin/observability";
import type { AlertPolicy } from "@crossengin/observability";
import {
  autoDeclaredForKey,
  type IncidentCategory,
  type IncidentRecord,
  type Severity,
} from "@crossengin/incident-response";
import {
  CountingIncidentDeclarer,
  type IncidentCloseOut,
  type IncidentDeclarer,
} from "@crossengin/incident-response-runtime";
import { SystemClock, parseDurationMs, type Clock } from "./clock.js";
import { RollingWindow, type RequestOutcome } from "./window.js";
import {
  DEFAULT_LATENCY_THRESHOLDS,
  evaluateLatencyTarget,
  type LatencyThreshold,
  type LatencyVerdict,
} from "./latency.js";
import {
  closeOutEnforcementIncident,
  declareEnforcementIncident,
  findOpenEnforcementIncident,
  formatKillSwitchId,
  planKillSwitchActivation,
  planPageDirective,
  type DeclarationErrorSink,
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
  /**
   * Chooses each declared incident's id and decides whether the record outlives the process.
   * Defaults to a per-process counter, which is only safe while nothing stores the record — see
   * `CountingIncidentDeclarer`.
   */
  readonly declarer?: IncidentDeclarer;
  readonly onDeclarationError?: DeclarationErrorSink;
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
      /** What became of the declared incident: cancelled, left to a human, or never stored. */
      readonly closeOut: IncidentCloseOut;
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
  private readonly declarer: IncidentDeclarer;
  private readonly onDeclarationError: DeclarationErrorSink | undefined;
  private readonly active: Map<string, ActiveBreach> = new Map();
  /**
   * Surfaces with a declaration in flight. A breach is only recorded as active once its id comes
   * back, so without this a second pass starting mid-declare would declare the same breach twice.
   */
  private readonly declaring: Set<string> = new Set();
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
    this.declarer = options.declarer ?? new CountingIncidentDeclarer({ clock: this.clock });
    this.onDeclarationError = options.onDeclarationError;
  }

  recordOutcome(outcome: RequestOutcome): void {
    this.window.record(outcome);
  }

  activeBreaches(): readonly { surface: string; breach: ActiveBreach }[] {
    return [...this.active.entries()].map(([surface, breach]) => ({ surface, breach }));
  }

  /**
   * Async for the same reason the availability engine's pass is: declaring means asking whoever
   * stores the record for the incident's id.
   */
  async evaluate(
    now: Date = this.clock.now(),
  ): Promise<readonly LatencyEnforcementDecision[]> {
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
        if (this.declaring.has(surface)) continue;
        const adopted = await this.adopt(reg, surface);
        if (adopted !== null) {
          decisions.push(adopted);
          continue;
        }
        const opened = await this.openBreach(reg, surface, verdict, nowIso);
        // A declaration that could not be recorded leaves the surface unopened, so the next tick
        // declares it instead of this pass abandoning every surface after it.
        if (opened !== null) decisions.push(opened);
      } else if (verdict.breached && existing !== undefined) {
        decisions.push({
          kind: "breach_ongoing",
          surface,
          sloId: reg.slo.id,
          incidentId: existing.incidentId,
        });
      } else if (!verdict.breached && existing !== undefined) {
        this.active.delete(surface);
        const closeOut = await closeOutEnforcementIncident(
          this.declarer,
          existing.incidentId,
          {
            reason: `latency on ${surface} is back within its budget`,
            actorUserId: this.declaredBy,
            at: nowIso,
          },
          { surface, sloId: reg.slo.id },
          this.onDeclarationError,
        );
        decisions.push({
          kind: "recovered",
          surface,
          sloId: reg.slo.id,
          incidentId: existing.incidentId,
          killSwitchId: existing.killSwitchId,
          closeOut,
        });
      }
    }

    return decisions;
  }

  /** Namespaced by signal, so the latency breach on a surface is not the availability one. */
  private keyFor(surface: string): string {
    return autoDeclaredForKey("latency", surface);
  }

  /**
   * Adopts the incident this surface already has open — see the availability engine's `adopt`. A
   * restart mid-breach would otherwise declare a second incident for one episode.
   */
  private async adopt(
    reg: LatencyRegistration,
    surface: string,
  ): Promise<LatencyEnforcementDecision | null> {
    const open = await findOpenEnforcementIncident(
      this.declarer,
      this.keyFor(surface),
      { surface, sloId: reg.slo.id },
      this.onDeclarationError,
    );
    if (open === null) return null;
    this.active.set(surface, {
      incidentId: open.id,
      // Nothing persists the kill switch, so a restart cannot recover which flag was rolled back.
      killSwitchId: null,
      severity: open.severity,
    });
    return { kind: "breach_ongoing", surface, sloId: reg.slo.id, incidentId: open.id };
  }

  private async openBreach(
    reg: LatencyRegistration,
    surface: string,
    verdict: LatencyVerdict,
    nowIso: string,
  ): Promise<LatencyEnforcementDecision | null> {
    const severity = verdict.worstSeverity as Severity;

    const worst = verdict.breaches.find(
      (b) => b.severity === severity && b.percentile === verdict.worstPercentile,
    );
    const detail =
      worst !== undefined
        ? `${worst.percentile} ${Math.round(worst.observedMs)}ms exceeds budget ${Math.round(worst.budgetMs)}ms (x${worst.multiplier} → ${Math.round(worst.thresholdMs)}ms)`
        : "latency budget breached";

    // The id is the declarer's to choose, so the record comes back before anything that embeds it.
    this.declaring.add(surface);
    let incident: IncidentRecord | null;
    try {
      incident = await declareEnforcementIncident(
        this.declarer,
        {
          title: `Latency SLO breach: ${reg.slo.id} on ${surface}`,
          autoDeclaredFor: this.keyFor(surface),
          severity,
          category: reg.category ?? "performance",
          surface,
          nowIso,
          declaredBy: this.declaredBy,
          detail: `Auto-declared by latency enforcement (${verdict.worstThresholdId}): ${detail}.`,
        },
        { surface, sloId: reg.slo.id },
        this.onDeclarationError,
      );
    } finally {
      this.declaring.delete(surface);
    }
    if (incident === null) return null;
    const incidentId = incident.id;

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
