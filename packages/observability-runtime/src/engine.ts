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
  DEFAULT_KILL_SWITCH_TTL_MS,
  activateKillSwitch,
  closeOutEnforcementIncident,
  escalationDue,
  severityRank,
  regradeEnforcementIncident,
  releaseRecoveredKillSwitch,
  declareEnforcementIncident,
  findAdoptedKillSwitch,
  findOpenEnforcementIncident,
  killSwitchIdForIncident,
  planPageDirective,
  type BreachEscalation,
  type DeclarationErrorSink,
  type EnforcementPlan,
  type IncidentRegrader,
  type KillSwitchRelease,
  type KillSwitchReleaser,
  type PageDirective,
  type KillSwitchActivation,
  type FlagRollback,
  type KillSwitchLookup,
  type KillSwitchRecorder,
} from "./enforcement.js";

export interface SloRegistration {
  readonly slo: Slo;
  readonly category?: IncidentCategory;
  readonly rollback?: FlagRollback;
  readonly tenantId?: string | null;
  /** Re-grade and re-page a breach still burning this long after it was declared (M-23). */
  readonly escalation?: BreachEscalation;
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
  /**
   * Recovers which kill switch an adopted incident recorded. Without it an adopted breach reports
   * none, because the id was only ever in the memory of the process that recorded it.
   */
  readonly killSwitches?: KillSwitchLookup;
  /**
   * Stores the kill switch a declared rollback plans. Absent, the switch is planned and carried on
   * the decision but stored nowhere — the in-memory engine's meaning of a kill switch.
   */
  readonly killSwitchRecorder?: KillSwitchRecorder;
  /** Releases a recovered breach's kill switch. Absent, a recovered switch stays recorded active. */
  readonly killSwitchReleaser?: KillSwitchReleaser;
  /** How long a recorded kill switch stays active if no recovery releases it. */
  readonly killSwitchTtlMs?: number;
  /** Re-grades a stored incident when a registration's escalation is due. */
  readonly regrader?: IncidentRegrader;
  readonly onDeclarationError?: DeclarationErrorSink;
}

interface ActiveBreach {
  readonly incidentId: string;
  readonly killSwitchId: string | null;
  readonly severity: Severity;
  readonly thresholdId: string;
  readonly openedAtMs: number;
  readonly escalated: boolean;
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
      readonly kind: "breach_escalated";
      readonly surface: string;
      readonly sloId: string;
      readonly incidentId: string;
      readonly fromSeverity: Severity;
      readonly severity: Severity;
      /** The re-page at the new grade, planned against the alert policy. */
      readonly pages: readonly PageDirective[];
      /** Whether the stored incident now carries the new grade; the re-page does not depend on it. */
      readonly regraded: boolean;
    }
  | {
      readonly kind: "recovered";
      readonly surface: string;
      readonly sloId: string;
      readonly incidentId: string;
      readonly killSwitchId: string | null;
      /** What became of the declared incident: cancelled, left to a human, or never stored. */
      readonly closeOut: IncidentCloseOut;
      /** What became of the breach's kill switch. */
      readonly killSwitchRelease: KillSwitchRelease;
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
  private readonly killSwitches: KillSwitchLookup | undefined;
  private readonly killSwitchRecorder: KillSwitchRecorder | undefined;
  private readonly killSwitchReleaser: KillSwitchReleaser | undefined;
  private readonly killSwitchTtlMs: number;
  private readonly regrader: IncidentRegrader | undefined;
  private readonly onDeclarationError: DeclarationErrorSink | undefined;
  private readonly active: Map<string, ActiveBreach> = new Map();
  /**
   * Surfaces with a declaration in flight. A breach is only recorded as active once its id comes
   * back, so without this a second pass starting mid-declare would declare the same breach twice.
   */
  private readonly declaring: Set<string> = new Set();

  constructor(options: SloEnforcementEngineOptions) {
    this.alertPolicy = options.alertPolicy;
    this.systemActorUserId = options.systemActorUserId;
    this.registrations = options.registrations;
    this.thresholds = options.thresholds ?? DEFAULT_BURN_RATE_THRESHOLDS;
    this.clock = options.clock ?? new SystemClock();
    this.declaredBy = options.declaredBy ?? "system-slo-enforcer";
    this.window = options.window ?? new RollingWindow();
    this.declarer = options.declarer ?? new CountingIncidentDeclarer({ clock: this.clock });
    this.killSwitches = options.killSwitches;
    this.killSwitchRecorder = options.killSwitchRecorder;
    this.killSwitchReleaser = options.killSwitchReleaser;
    this.killSwitchTtlMs = options.killSwitchTtlMs ?? DEFAULT_KILL_SWITCH_TTL_MS;
    if (!Number.isInteger(this.killSwitchTtlMs) || this.killSwitchTtlMs < 60_000) {
      throw new Error("killSwitchTtlMs must be an integer of at least 60000");
    }
    this.regrader = options.regrader;
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
        if (escalationDue(reg.escalation, existing, nowMs)) {
          decisions.push(await this.escalate(reg, surface, existing, reg.escalation, nowIso));
          continue;
        }
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
        // Released whatever became of the incident: the burn that justified the switch is over,
        // and a switch nobody releases stays `triggered_active` for ever (ADR-0415's open end).
        const killSwitchRelease = await releaseRecoveredKillSwitch(
          this.killSwitchReleaser,
          existing.killSwitchId,
          reg.tenantId ?? null,
          {
            reason: `error-budget burn on ${surface} recovered (incident ${existing.incidentId})`,
            actorUserId: this.systemActorUserId,
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
          killSwitchRelease,
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
      // Recovered from the store when one is wired; null otherwise, because the id was only ever in
      // the memory of the process that activated it.
      killSwitchId: await findAdoptedKillSwitch(
        this.killSwitches,
        open.id,
        { surface, sloId: reg.slo.id },
        this.onDeclarationError,
      ),
      severity: open.severity,
      thresholdId: verdict.worstThresholdId ?? "unknown",
      // The episode began when the incident was declared, not when this process adopted it, so a
      // restart does not reset the escalation clock.
      openedAtMs: Date.parse(open.declaredAt),
      escalated:
        reg.escalation !== undefined &&
        severityRankAtOrAbove(open.severity, reg.escalation.severity),
    });
    return { kind: "breach_ongoing", surface, sloId: reg.slo.id, incidentId: open.id };
  }

  private async escalate(
    reg: SloRegistration,
    surface: string,
    existing: ActiveBreach,
    escalation: BreachEscalation,
    nowIso: string,
  ): Promise<EnforcementDecision> {
    const regraded = await regradeEnforcementIncident(
      this.regrader,
      existing.incidentId,
      {
        severity: escalation.severity,
        reason: `error-budget burn on ${surface} has persisted past ${escalation.afterMs.toString()}ms`,
        actorUserId: this.declaredBy,
        at: nowIso,
      },
      { surface, sloId: reg.slo.id },
      this.onDeclarationError,
    );
    // Marked escalated whether or not the record took the grade, so a failing regrader cannot turn
    // the re-page into one per tick.
    this.active.set(surface, { ...existing, severity: escalation.severity, escalated: true });
    const page = planPageDirective(this.alertPolicy, escalation.severity, existing.incidentId);
    return {
      kind: "breach_escalated",
      surface,
      sloId: reg.slo.id,
      incidentId: existing.incidentId,
      fromSeverity: existing.severity,
      severity: escalation.severity,
      pages: page === null ? [] : [page],
      regraded,
    };
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

    // After the declaration, so nothing here may throw: a refused plan or a failed write is
    // reported and carried on the plan, and the incident keeps its page.
    const activation: KillSwitchActivation =
      reg.rollback === undefined
        ? { killSwitch: null, unrecorded: null }
        : await activateKillSwitch(
            {
              killSwitchId: killSwitchIdForIncident(incidentId),
              flagId: reg.rollback.flagId,
              safeValueJson: reg.rollback.safeValueJson,
              tenantId: reg.tenantId ?? null,
              systemActorUserId: this.systemActorUserId,
              incidentId,
              nowIso,
              justification: `SLO enforcement recorded a kill switch for ${reg.rollback.flagId} after ${thresholdId} burn on ${surface}.`,
              expiresAtIso: new Date(Date.parse(nowIso) + this.killSwitchTtlMs).toISOString(),
            },
            this.killSwitchRecorder,
            { surface, sloId: reg.slo.id },
            this.onDeclarationError,
          );
    const killSwitchId = activation.killSwitch?.id ?? null;

    this.active.set(surface, {
      incidentId,
      killSwitchId,
      severity,
      thresholdId,
      openedAtMs: Date.parse(nowIso),
      escalated: false,
    });

    return {
      kind: "breach_opened",
      surface,
      sloId: reg.slo.id,
      severity,
      verdict,
      plan: {
        incident,
        pages,
        killSwitch: activation.killSwitch,
        killSwitchUnrecorded: activation.unrecorded,
      },
    };
  }
}

function severityRankAtOrAbove(current: Severity, target: Severity): boolean {
  return severityRank(current) <= severityRank(target);
}
