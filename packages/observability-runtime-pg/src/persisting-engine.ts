import type { PgConnection } from "@crossengin/kernel-pg";
import {
  SloEnforcementEngine,
  type EnforcementDecision,
  type SloEnforcementEngineOptions,
} from "@crossengin/observability-runtime";
import { PostgresSloEvaluationStore } from "./evaluation-store.js";
import { PostgresSloEnforcementActionStore } from "./enforcement-action-store.js";
import {
  enforcementActionFromDecision,
  evaluationRecordFromVerdict,
} from "./records.js";

export interface PersistentSloEnforcementEngineOptions
  extends SloEnforcementEngineOptions {
  readonly resolveTenantId?: (surface: string) => string | null;
}

export interface PersistentSloEnforcementEngine {
  readonly engine: SloEnforcementEngine;
  readonly evaluationStore: PostgresSloEvaluationStore;
  readonly enforcementStore: PostgresSloEnforcementActionStore;
  recordOutcome: SloEnforcementEngine["recordOutcome"];
  evaluate(now?: Date): Promise<readonly EnforcementDecision[]>;
}

interface SurfaceMeta {
  readonly target: number;
  readonly tenantId: string | null;
}

function buildSurfaceMeta(
  options: PersistentSloEnforcementEngineOptions,
): Map<string, SurfaceMeta> {
  const map = new Map<string, SurfaceMeta>();
  for (const reg of options.registrations) {
    const availability = reg.slo.targets.find((t) => t.kind === "availability");
    if (availability === undefined || availability.kind !== "availability") continue;
    map.set(reg.slo.surface, {
      target: availability.target,
      tenantId: reg.tenantId ?? null,
    });
  }
  return map;
}

export function buildPersistentSloEnforcementEngine(
  conn: PgConnection,
  options: PersistentSloEnforcementEngineOptions,
): PersistentSloEnforcementEngine {
  const engine = new SloEnforcementEngine(options);
  const evaluationStore = new PostgresSloEvaluationStore(conn);
  const enforcementStore = new PostgresSloEnforcementActionStore(conn);
  const surfaceMeta = buildSurfaceMeta(options);
  const clock = options.clock;

  function tenantFor(surface: string, fallback: string | null): string | null {
    const fromReg = surfaceMeta.get(surface)?.tenantId ?? null;
    if (fromReg !== null) return fromReg;
    if (options.resolveTenantId !== undefined) return options.resolveTenantId(surface);
    return fallback;
  }

  async function evaluate(now?: Date): Promise<readonly EnforcementDecision[]> {
    const at = now ?? clock?.now() ?? new Date();
    const occurredAt = at.toISOString();
    const decisions = engine.evaluate(at);

    for (const decision of decisions) {
      const killSwitchTenant =
        decision.kind === "breach_opened"
          ? decision.plan.killSwitch?.tenantId ?? null
          : null;
      const tenantId = tenantFor(decision.surface, killSwitchTenant);

      const action = enforcementActionFromDecision({
        decision,
        tenantId,
        occurredAt,
      });
      await enforcementStore.record(action);

      if (decision.kind === "breach_opened") {
        const meta = surfaceMeta.get(decision.surface);
        if (meta !== undefined) {
          const record = evaluationRecordFromVerdict({
            sloId: decision.sloId,
            surface: decision.surface,
            tenantId,
            target: meta.target,
            verdict: decision.verdict,
            evaluatedAt: occurredAt,
          });
          await evaluationStore.record(record);
        }
      }
    }

    return decisions;
  }

  return {
    engine,
    evaluationStore,
    enforcementStore,
    recordOutcome: (outcome) => engine.recordOutcome(outcome),
    evaluate,
  };
}
