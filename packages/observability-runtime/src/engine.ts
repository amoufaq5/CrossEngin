import {
  type Slo,
  type SloAvailabilityTarget,
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
import { SystemClock, type Clock } from "./clock.js";
import { RollingWindow, type RequestOutcome } from "./window.js";
import {
  DEFAULT_BURN_RATE_THRESHOLDS,
  evaluateBurnRate,
  type BurnRateThreshold,
  type BurnRateVerdict,
} from "./burn-rate.js";
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
      /** What became of the declared incident: cancelled, left to a human, or never stored. */
      readonly closeOut: IncidentCloseOut;
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
  private readonly declarer: IncidentDeclarer;
  private readonly onDeclarationError: DeclarationErrorSink | undefined;
  private readonly active: Map<string, ActiveBreach> = new Map();
  /**
   * Surfaces with a declaration in flight. A breach is only recorded as active once its id comes
   * back, so without this a second pass starting mid-declare would declare the same breach twice.
   */
  private readonly declaring: Set<string> = new Set();
  private killSwitchSeq = 0;

  constructor(options: SloEnforcementEngineOptions) {
    this.alertPolicy = options.alertPolicy;
    this.systemActorUserId = options.systemActorUserId;
    this.registrations = options.registrations;
    this.thresholds = options.thresholds ?? DEFAULT_BURN_RATE_THRESHOLDS;
    this.clock = options.clock ?? new SystemClock();
    this.declaredBy = options.declaredBy ?? "system-slo-enforcer";
    this.window = options.window ?? new RollingWindow();
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
   * Async because declaring is: the incident's id comes from whoever will store the record, so the
   * engine cannot know it without asking. Recording outcomes stays synchronous — only this pass,
   * which runs on a timer, waits on anything.
   */
  async evaluate(now: Date = this.clock.now()): Promise<readonly EnforcementDecision[]> {
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
        if (this.declaring.has(surface)) continue;
        const adopted = await this.adopt(reg, surface, verdict);
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
          sloId: slo.id,
          incidentId: existing.incidentId,
        });
      } else if (!verdict.breached && existing !== undefined) {
        this.active.delete(surface);
        const closeOut = await closeOutEnforcementIncident(
          this.declarer,
          existing.incidentId,
          {
            reason: `error-budget burn on ${surface} is back within its ${existing.thresholdId} threshold`,
            actorUserId: this.declaredBy,
            at: nowIso,
          },
          { surface, sloId: slo.id },
          this.onDeclarationError,
        );
        decisions.push({
          kind: "recovered",
          surface,
          sloId: slo.id,
          incidentId: existing.incidentId,
          killSwitchId: existing.killSwitchId,
          closeOut,
        });
      }
    }

    return decisions;
  }

  /** The key this engine's incidents are declared under: namespaced, so latency cannot adopt one. */
  private keyFor(surface: string): string {
    return autoDeclaredForKey("availability", surface);
  }

  /**
   * Adopts the incident this surface already has open, when the store remembers one this process
   * does not.
   *
   * A restart mid-breach has an empty `active` map and a breach that is still burning, so without
   * this the next pass declares a second incident for one episode. The breach is reported as
   * `breach_ongoing`, which is what it is: it was opened, and it was opened before this process
   * started. Nothing is paged again — the page went out when the incident was declared.
   */
  private async adopt(
    reg: SloRegistration,
    surface: string,
    verdict: BurnRateVerdict,
  ): Promise<EnforcementDecision | null> {
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
      thresholdId: verdict.worstThresholdId ?? "unknown",
    });
    return { kind: "breach_ongoing", surface, sloId: reg.slo.id, incidentId: open.id };
  }

  private async openBreach(
    reg: SloRegistration,
    surface: string,
    verdict: BurnRateVerdict,
    nowIso: string,
  ): Promise<EnforcementDecision | null> {
    const severity = verdict.worstSeverity as Severity;
    const thresholdId = verdict.worstThresholdId as string;

    const worst = verdict.evaluations.find((e) => e.threshold.id === thresholdId);
    const burnDetail =
      worst !== undefined
        ? `burn ${worst.longBurn.toFixed(1)}x over ${worst.threshold.longWindow} / ${worst.shortBurn.toFixed(1)}x over ${worst.threshold.shortWindow}`
        : "burn threshold breached";

    // The id is the declarer's to choose, so the record comes back before anything that embeds it.
    this.declaring.add(surface);
    let incident: IncidentRecord | null;
    try {
      incident = await declareEnforcementIncident(
        this.declarer,
        {
          title: `SLO burn alert: ${reg.slo.id} on ${surface}`,
          autoDeclaredFor: this.keyFor(surface),
          severity,
          ...(reg.category !== undefined ? { category: reg.category } : {}),
          surface,
          nowIso,
          declaredBy: this.declaredBy,
          detail: `Auto-declared by SLO enforcement (${thresholdId}): ${burnDetail}.`,
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
