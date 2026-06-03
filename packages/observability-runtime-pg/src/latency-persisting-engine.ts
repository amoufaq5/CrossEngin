import type { PgConnection } from "@crossengin/kernel-pg";
import {
  LatencySloEngine,
  type LatencyEnforcementDecision,
  type LatencySloEngineOptions,
} from "@crossengin/observability-runtime";
import { PostgresSloEnforcementActionStore } from "./enforcement-action-store.js";
import { PostgresSloLatencyEvaluationStore } from "./latency-evaluation-store.js";
import {
  enforcementActionFromDecision,
  latencyEvaluationRecordFromVerdict,
} from "./records.js";

export interface PersistentLatencySloEngineOptions extends LatencySloEngineOptions {
  readonly resolveTenantId?: (surface: string) => string | null;
}

export interface PersistentLatencySloEngine {
  readonly engine: LatencySloEngine;
  readonly latencyEvaluationStore: PostgresSloLatencyEvaluationStore;
  readonly enforcementStore: PostgresSloEnforcementActionStore;
  recordOutcome: LatencySloEngine["recordOutcome"];
  evaluate(now?: Date): Promise<readonly LatencyEnforcementDecision[]>;
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
  const engine = new LatencySloEngine(options);
  const latencyEvaluationStore = new PostgresSloLatencyEvaluationStore(conn);
  const enforcementStore = new PostgresSloEnforcementActionStore(conn);
  const tenantBySurface = buildTenantMap(options);
  const clock = options.clock;

  function tenantFor(surface: string, fallback: string | null): string | null {
    const fromReg = tenantBySurface.get(surface) ?? null;
    if (fromReg !== null) return fromReg;
    if (options.resolveTenantId !== undefined) return options.resolveTenantId(surface);
    return fallback;
  }

  async function evaluate(now?: Date): Promise<readonly LatencyEnforcementDecision[]> {
    const at = now ?? clock?.now() ?? new Date();
    const occurredAt = at.toISOString();
    const decisions = engine.evaluate(at);

    for (const decision of decisions) {
      const killSwitchTenant =
        decision.kind === "breach_opened"
          ? decision.plan.killSwitch?.tenantId ?? null
          : null;
      const tenantId = tenantFor(decision.surface, killSwitchTenant);

      await enforcementStore.record(
        enforcementActionFromDecision({
          decision,
          tenantId,
          occurredAt,
          signal: "latency",
        }),
      );

      if (decision.kind === "breach_opened") {
        await latencyEvaluationStore.record(
          latencyEvaluationRecordFromVerdict({
            sloId: decision.sloId,
            surface: decision.surface,
            tenantId,
            verdict: decision.verdict,
            evaluatedAt: occurredAt,
          }),
        );
      }
    }

    return decisions;
  }

  return {
    engine,
    latencyEvaluationStore,
    enforcementStore,
    recordOutcome: (outcome) => engine.recordOutcome(outcome),
    evaluate,
  };
}
