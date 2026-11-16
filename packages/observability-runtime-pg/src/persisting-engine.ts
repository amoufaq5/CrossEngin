import type { PgConnection } from "@crossengin/kernel-pg";
import { PostgresIncidentDeclarer } from "@crossengin/incident-response-runtime-pg";
import { PostgresKillSwitchStore } from "@crossengin/feature-flags-pg";
import {
  SloEnforcementEngine,
  type DeclarationErrorSink,
  type EnforcementDecision,
  type EnforcementFailurePhase,
  type KillSwitchLookup,
  type SloEnforcementEngineOptions,
} from "@crossengin/observability-runtime";
import { PostgresSloEvaluationStore } from "./evaluation-store.js";
import { PostgresSloEnforcementActionStore } from "./enforcement-action-store.js";
import {
  enforcementActionFromDecision,
  evaluationRecordFromVerdict,
} from "./records.js";

// Re-exported, not restated: whether anything applies the kill switches these engines write is
// `feature-flags-pg`'s one fact, and the boot line that says so lives in operate-server, which
// depends on this package and not on that one.
export { KILL_SWITCH_ENFORCEMENT_GAP } from "@crossengin/feature-flags-pg";

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
  // The kill switch is written by the engine as the breach opens — so one it could not store is
  // never remembered as the breach's — and read back when a restart adopts the incident.
  const killSwitchStore = new PostgresKillSwitchStore(conn);
  const engine = new SloEnforcementEngine({
    ...options,
    declarer: options.declarer ?? new PostgresIncidentDeclarer({ conn }),
    killSwitches: options.killSwitches ?? killSwitchLookup(killSwitchStore),
    killSwitchRecorder: options.killSwitchRecorder ?? killSwitchStore,
  });
  const evaluationStore = new PostgresSloEvaluationStore(conn);
  const enforcementStore = new PostgresSloEnforcementActionStore(conn);
  const surfaceMeta = buildSurfaceMeta(options);
  const clock = options.clock;
  const onError = options.onDeclarationError;

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

      // The engine stored any kill switch this decision names before returning it, so the action
      // row never names a switch with no row behind it.
      await persistReported(decision, "record_enforcement_action", onError, () =>
        enforcementStore.record(
          enforcementActionFromDecision({
            decision,
            tenantId,
            occurredAt,
          }),
        ),
      );

      if (decision.kind === "breach_opened") {
        const meta = surfaceMeta.get(decision.surface);
        if (meta !== undefined) {
          await persistReported(decision, "record_evaluation", onError, () =>
            evaluationStore.record(
              evaluationRecordFromVerdict({
                sloId: decision.sloId,
                surface: decision.surface,
                tenantId,
                target: meta.target,
                verdict: decision.verdict,
                evaluatedAt: occurredAt,
              }),
            ),
          );
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
 * Writes one projection of a decision, reporting a failure instead of throwing it.
 *
 * Every decision here is about an incident that is already declared, and the engine has already
 * remembered its breach as active — so a throw would reject the pass the scheduler pages from, and
 * the next pass answers `breach_ongoing` with nothing to page. The page is worth more than the row:
 * the row is lost and reported, the page goes out.
 */
export async function persistReported(
  decision: { readonly surface: string; readonly sloId: string },
  phase: Extract<EnforcementFailurePhase, "record_enforcement_action" | "record_evaluation">,
  onError: DeclarationErrorSink | undefined,
  write: () => Promise<void>,
): Promise<void> {
  try {
    await write();
  } catch (err) {
    onError?.(err, { surface: decision.surface, sloId: decision.sloId, phase });
  }
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
