import type { PgConnection } from "@crossengin/kernel-pg";
import { PostgresIncidentDeclarer } from "@crossengin/incident-response-runtime-pg";
import { PostgresKillSwitchStore } from "@crossengin/feature-flags-pg";
import {
  LatencySloEngine,
  type LatencyEnforcementDecision,
  type LatencySloEngineOptions,
} from "@crossengin/observability-runtime";
import {
  deliverReported,
  incidentRegrader,
  killSwitchLookup,
  killSwitchReleaser,
  persistReported,
  type EnforcementPageDeliverer,
  type PersistedDecision,
} from "./persisting-engine.js";
import { PostgresSloEnforcementActionStore } from "./enforcement-action-store.js";
import { PostgresSloLatencyEvaluationStore } from "./latency-evaluation-store.js";
import {
  enforcementActionFromDecision,
  latencyEvaluationRecordFromVerdict,
} from "./records.js";

export interface PersistentLatencySloEngineOptions extends LatencySloEngineOptions {
  readonly resolveTenantId?: (surface: string) => string | null;
  /** See the availability engine's option. */
  readonly deliverPages?: EnforcementPageDeliverer;
}

export interface PersistentLatencySloEngine {
  readonly engine: LatencySloEngine;
  readonly latencyEvaluationStore: PostgresSloLatencyEvaluationStore;
  readonly enforcementStore: PostgresSloEnforcementActionStore;
  readonly killSwitchStore: PostgresKillSwitchStore;
  recordOutcome: LatencySloEngine["recordOutcome"];
  evaluate(now?: Date): Promise<readonly PersistedDecision<LatencyEnforcementDecision>[]>;
}

function buildTenantMap(
  options: PersistentLatencySloEngineOptions,
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const reg of options.registrations) {
    map.set(reg.slo.surface, reg.tenantId ?? null);
  }
  return map;
}

export function buildPersistentLatencySloEngine(
  conn: PgConnection,
  options: PersistentLatencySloEngineOptions,
): PersistentLatencySloEngine {
  // Same reason as the availability engine: a persisted evaluation must not name an unpersisted
  // incident. A shared declarer is passed in when both engines declare against one store.
  const killSwitchStore = new PostgresKillSwitchStore(conn);
  const engine = new LatencySloEngine({
    ...options,
    declarer: options.declarer ?? new PostgresIncidentDeclarer({ conn }),
    killSwitches: options.killSwitches ?? killSwitchLookup(killSwitchStore),
    killSwitchRecorder: options.killSwitchRecorder ?? killSwitchStore,
    killSwitchReleaser: options.killSwitchReleaser ?? killSwitchReleaser(killSwitchStore),
    regrader: options.regrader ?? incidentRegrader(conn),
  });
  const latencyEvaluationStore = new PostgresSloLatencyEvaluationStore(conn);
  const enforcementStore = new PostgresSloEnforcementActionStore(conn);
  const tenantBySurface = buildTenantMap(options);
  const clock = options.clock;
  const onError = options.onDeclarationError;

  function tenantFor(surface: string, fallback: string | null): string | null {
    const fromReg = tenantBySurface.get(surface) ?? null;
    if (fromReg !== null) return fromReg;
    if (options.resolveTenantId !== undefined) return options.resolveTenantId(surface);
    return fallback;
  }

  async function evaluate(
    now?: Date,
  ): Promise<readonly PersistedDecision<LatencyEnforcementDecision>[]> {
    const at = now ?? clock?.now() ?? new Date();
    const occurredAt = at.toISOString();
    const decisions = await engine.evaluate(at);
    const out: PersistedDecision<LatencyEnforcementDecision>[] = [];

    for (const decision of decisions) {
      const pageDelivery = await deliverReported(decision, options.deliverPages, onError);
      out.push({ ...decision, pageDelivery });
      const killSwitchTenant =
        decision.kind === "breach_opened"
          ? decision.plan.killSwitch?.tenantId ?? null
          : null;
      const tenantId = tenantFor(decision.surface, killSwitchTenant);

      // The kill switch is stored by the engine, before the action row — see the availability engine.
      await persistReported(decision, "record_enforcement_action", onError, () =>
        enforcementStore.record(
          enforcementActionFromDecision({
            decision,
            tenantId,
            occurredAt,
            signal: "latency",
            pageDelivery,
          }),
        ),
      );

      if (decision.kind === "breach_opened") {
        await persistReported(decision, "record_evaluation", onError, () =>
          latencyEvaluationStore.record(
            latencyEvaluationRecordFromVerdict({
              sloId: decision.sloId,
              surface: decision.surface,
              tenantId,
              verdict: decision.verdict,
              evaluatedAt: occurredAt,
            }),
          ),
        );
      }
    }

    return out;
  }

  return {
    engine,
    latencyEvaluationStore,
    enforcementStore,
    killSwitchStore,
    recordOutcome: (outcome) => engine.recordOutcome(outcome),
    evaluate,
  };
}
