import { KILL_SWITCH_ENFORCEMENT_GAP } from "@crossengin/observability-runtime-pg";

import type { SloConfig, SloRegistrationConfig } from "./slo-config.js";

export interface SloRollbackDeclaration {
  readonly signal: "availability" | "latency";
  readonly sloId: string;
  readonly flagId: string;
}

export interface SloRollbackSurvey {
  readonly declarations: readonly SloRollbackDeclaration[];
  /** Whether a breach stores its kill switch (`--store pg`) or only plans it. */
  readonly persisted: boolean;
  /**
   * Whether anything in this binary applies a kill switch to a flag — assigned from
   * `KILL_SWITCH_ENFORCEMENT_GAP.enforced`, the one place that fact is written, and typed `false` so
   * the day that constant flips this module stops compiling. That fences the *constant*, not the
   * sentence: `formatSloRollbackSurvey` reads neither this field nor the constant, and its "nothing
   * applies it" clause is a fixed string, so rewording the clause is caught by nothing here
   * (ADR-0415). Not a branch: the honest sentence once enforcement exists is a per-deployment one
   * (is the evaluator mounted here?) that a workspace-level constant cannot answer.
   */
  readonly killSwitchApplied: false;
}

/**
 * Every registration that declares a flag rollback, across both signals, in config order.
 *
 * Takes the merged config rather than a file, because a rollback reaches the engines by two routes —
 * `--slo-config`, and `--slo-defaults` with `--slo-defaults-override`'s `extraAvailability` /
 * `extraLatency`, which are the same registration schema — and a survey of one route would tell the
 * other's operator nothing.
 */
export function surveySloRollbacks(config: SloConfig, persisted: boolean): SloRollbackSurvey {
  const of = (
    signal: SloRollbackDeclaration["signal"],
    regs: readonly SloRegistrationConfig[] | undefined,
  ): SloRollbackDeclaration[] =>
    (regs ?? []).flatMap((reg) =>
      reg.rollback === undefined ? [] : [{ signal, sloId: reg.slo.id, flagId: reg.rollback.flagId }],
    );
  return {
    declarations: [...of("availability", config.availability), ...of("latency", config.latency)],
    persisted,
    killSwitchApplied: KILL_SWITCH_ENFORCEMENT_GAP.enforced,
  };
}

/**
 * One `[slo]` line for a deployment whose registrations declare a rollback, or null when none does.
 *
 * Says what a breach does with the block and what it does not, because the block reads as a rollback
 * and nothing rolls anything back. Names no flag an operator passed: the block arrives by either of
 * two routes. Silent when nothing declares one — a line on every deployment about a block nobody
 * wrote would be noise.
 */
export function formatSloRollbackSurvey(survey: SloRollbackSurvey): string | null {
  const { declarations } = survey;
  if (declarations.length === 0) return null;
  const named = declarations.map((d) => `${d.signal} ${d.sloId} → ${d.flagId}`).join(", ");
  const kept = survey.persisted
    ? "records a kill switch for that flag in meta.feature_flag_kill_switches"
    : "plans a kill switch for that flag and stores it nowhere (no --store pg)";
  return (
    `[slo] ${String(declarations.length)} SLO registration(s) declare a flag rollback (${named}): ` +
    `a breach on one ${kept}. Nothing in this binary applies a kill switch to a flag, so no ` +
    "traffic is withheld. A kill switch that cannot be planned or stored is given up, and costs " +
    "neither the incident nor its page."
  );
}
