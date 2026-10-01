import type { PgConnection } from "@crossengin/kernel-pg";
import { PostgresIncidentDeclarer } from "@crossengin/incident-response-runtime-pg";
import { PostgresKillSwitchStore } from "@crossengin/feature-flags-pg";
import {
  SloEnforcementEngine,
  type EnforcementDecision,
  type KillSwitchLookup,
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
  readonly killSwitchStore: PostgresKillSwitchStore;
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
  // The declarer defaults to the incident store on this connection: an engine whose evaluations and
  // actions are written must not name incidents that are not. A caller may pass its own to share one
  // store with the latency engine and anything else that declares.
  // The kill switch is written when a breach opens and read back when a restart adopts it, so the
  // flag an incident rolled back survives the process that rolled it back.
  const killSwitchStore = new PostgresKillSwitchStore(conn);
  const engine = new SloEnforcementEngine({
    ...options,
    declarer: options.declarer ?? new PostgresIncidentDeclarer({ conn }),
    killSwitches: options.killSwitches ?? killSwitchLookup(killSwitchStore),
  });
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
    const decisions = await engine.evaluate(at);

    for (const decision of decisions) {
      const killSwitchTenant =
        decision.kind === "breach_opened"
          ? decision.plan.killSwitch?.tenantId ?? null
          : null;
      const tenantId = tenantFor(decision.surface, killSwitchTenant);

      if (decision.kind === "breach_opened" && decision.plan.killSwitch !== null) {
        // Before the action row that names it, so a reader never sees a `kill_switch_id` with no
        // switch behind it.
        await killSwitchStore.record(decision.plan.killSwitch);
      }

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
    killSwitchStore,
    recordOutcome: (outcome) => engine.recordOutcome(outcome),
    evaluate,
  };
}

/**
 * Adapts the kill-switch store to the engine's `KillSwitchLookup`.
 *
 * The engine must not depend on `feature-flags-pg`, so the seam is structural and the adapter lives
 * here, where both sides are already in scope.
 */
export function killSwitchLookup(
  store: PostgresKillSwitchStore,
  tenantId: string | null = null,
): KillSwitchLookup {
  return {
    findForIncident: async (incidentId: string): Promise<string | null> => {
      const found = await store.loadForIncident(incidentId, tenantId);
      return found === null ? null : found.id;
    },
  };
}
