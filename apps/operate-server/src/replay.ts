import type { PgConnection } from "@crossengin/kernel-pg";

/**
 * The read-only drift-replay surface: `operate-server replay`.
 *
 * ## Why this module exists
 *
 * Six packages ship a drift replayer — the thing that re-derives a projection from its own log
 * and reports where the two disagree — and **nothing in the workspace constructed any of them.**
 * Not a route, not a scheduler, not a CLI subcommand; only their own tests. CLAUDE.md advertised
 * each as a shipped capability ("ships a replayer", "a replayer that flags out-of-order stages",
 * "a replayer for drift repair"), and two of them were *bug-fixed in consecutive increments*
 * while nothing called them: ADR-0330 stopped the workflow replayer reporting drift on every
 * healthy instance, and ADR-0333 gave the DR replayer an issue kind it had been structurally
 * unable to emit. A detector's false positives and false negatives were both corrected, and no
 * deployment had ever run it.
 *
 * ADR-0336's reachability rule could not see any of this: it matches exported classes named
 * `Postgres*`, and declared that naming limit as a blind spot. Five of the six replayers are not
 * named `Postgres*` and the sixth is not a class at all.
 *
 * ## The scope rules, which are measured rather than chosen
 *
 * The six do **not** share one scoping story. Counted from `pg_policy` on a freshly bootstrapped
 * cluster, and verified live by booting as a non-owner role (`rolbypassrls = f`):
 *
 * - **`SCOPE_TENANT_ONLY`** — the tables carry `tenant_id NOT NULL` with the isolation policy as
 *   their *only* arm. A non-owner with no tenant context matches **zero** rows, and there is no
 *   platform arm to fall back to, so a cross-scope read is not merely owner-dependent: it is
 *   silently empty. Such a pass prints `0 findings` having read nothing, which is the single most
 *   misleading output this subcommand can produce — indistinguishable from a clean sweep. So a
 *   scope is **required** for these, and a scopeless invocation is refused rather than warned
 *   about: ADR-0322's rule is that a surface which degrades rather than refusing has to say so out
 *   loud, and here it cannot say it at the right volume, because the degraded answer *looks like*
 *   the healthy one. Nothing is destroyed by refusing.
 * - **`SCOPE_TENANT_OR_PLATFORM`** — isolation plus a platform `SELECT` arm. A non-owner with no
 *   context sees the platform's rows only. Measured on `GatewayReplayer` with seven real captured
 *   executions: `{tenantId: "…"}` → 6, `{tenantId: null}` → 1, and no scope at all → **1 as a
 *   non-owner but 7 as the owner**. The SQL is correct in every case; RLS is the limit. So
 *   "every scope" is an owner-only diagnostic, never a sweep.
 * - **`SCOPE_NONE`** — `meta.incidents` has no `tenant_id` column and no RLS block at all. A scope
 *   flag here is **rejected as a usage error** rather than ignored, because accepting one would
 *   promise a confinement the table cannot provide.
 *
 * A total map over `REPLAY_SUBSYSTEMS` rather than a predicate, so a seventh subsystem is a
 * compile error here instead of one inheriting whichever arm the chain happened to end on — the
 * rule ADR-0334 applied to `JOB_KIND_PRODUCERS` and `WORKFLOW_WORKER_NEEDS_DEFINITIONS`.
 *
 * ## What the report carries beyond its findings, and why both fields are needed
 *
 * `coverage` names *how* the scope was reached, because "clean from a per-tenant loop over three
 * tenants" and "clean from one unscoped read" are different claims and the second is frequently a
 * lie. `complete` says whether a `LIMIT` cut the set, because a complete-scope pass can still be
 * window-truncated — and then `0 findings` cannot be read as "nothing has drifted". They are
 * separate: a pass can be complete in scope and truncated in window, or vice versa.
 *
 * The findings themselves stay in **five vocabularies**, as a discriminated union keyed on
 * subsystem. They are deliberately not merged into one enum: the meanings do not align (a stored
 * outcome contradicting its own log, an append-only timeline out of order, a close-out the store
 * refused, and a contract-forbidden row are four different kinds of fact), and the finding
 * identity differs per subsystem with no common key. A collapsed enum would either lose those
 * distinctions or grow to forty-odd members, which is five enums in a trenchcoat.
 */
export const REPLAY_SUBSYSTEMS = [
  "dr",
  "slo",
  "access_reviews",
  "gateway",
  "incidents",
  "workflow",
] as const;
export type ReplaySubsystem = (typeof REPLAY_SUBSYSTEMS)[number];

/** How a subsystem's tables may be scoped — read off the catalog, not chosen. */
export const SCOPE_TENANT_ONLY = "tenant_only" as const;
export const SCOPE_TENANT_OR_PLATFORM = "tenant_or_platform" as const;
export const SCOPE_NONE = "none" as const;
export type ReplayScopeSupport =
  | typeof SCOPE_TENANT_ONLY
  | typeof SCOPE_TENANT_OR_PLATFORM
  | typeof SCOPE_NONE;

/**
 * Which scopes each subsystem's tables can actually serve.
 *
 * `access_reviews`: `access_review_campaigns` / `_items` / `_decisions`, isolation-only.
 * `workflow`: `workflow_instances` / `_events` / `_timers`, isolation-only — and its replayer
 * additionally requires an RLS-bypassing session by its own account, so the refusal below is the
 * cheaper of two gates rather than the only one.
 * `dr`: `dr_failover_executions` and `dr_drill_executions`, both with the full split.
 * (Not `dr_drills` — that is a separate Phase-1 table nothing reads or writes, declared on the
 * writerless census. Probing it instead was my own measurement error and it produced a false
 * claim that `DrReplayer` spanned two scoping stories; it does not.)
 * `slo`: `slo_enforcement_actions`, split. `gateway`: `gateway_pipeline_executions`, split.
 * `incidents`: `meta.incidents`, no `tenant_id`, no RLS.
 */
export const REPLAY_SCOPE_SUPPORT: Readonly<Record<ReplaySubsystem, ReplayScopeSupport>> =
  Object.freeze({
    dr: SCOPE_TENANT_OR_PLATFORM,
    slo: SCOPE_TENANT_OR_PLATFORM,
    access_reviews: SCOPE_TENANT_ONLY,
    gateway: SCOPE_TENANT_OR_PLATFORM,
    incidents: SCOPE_NONE,
    workflow: SCOPE_TENANT_ONLY,
  });

/** The scope one section was read under. */
export type ReplayCoverage =
  | { readonly kind: "tenant"; readonly tenantId: string }
  | { readonly kind: "platform" }
  | { readonly kind: "unscoped" };

export interface ReplaySection {
  readonly subsystem: ReplaySubsystem;
  readonly coverage: ReplayCoverage;
  /**
   * False when a `LIMIT` cut the set. Separate from `coverage`, and load-bearing: without it a
   * truncated pass reports `0 findings` and reads as "nothing has drifted".
   */
  readonly complete: boolean;
  /** Rows examined. Zero with `refusal === null` is a real empty scope; with a refusal it is nothing. */
  readonly scanned: number;
  /**
   * Why nothing was read, when that is the answer. A section that could not be read is **not** a
   * section with no findings, and conflating them is the defect this whole surface exists to end.
   */
  readonly refusal: string | null;
  /** The subsystem's own findings, rendered to strings at this boundary. */
  readonly findings: readonly string[];
}

export interface ReplayReport {
  readonly sections: readonly ReplaySection[];
  /** True iff every section was readable and none found anything. Drives the exit code. */
  readonly ok: boolean;
}

/**
 * Refusal text for a subsystem asked for without a scope it can serve.
 *
 * Exported so the CLI's usage error and the report's `refusal` are one string, and a test can
 * assert on it without matching prose.
 */
export function scopeRefusal(
  subsystem: ReplaySubsystem,
  coverage: ReplayCoverage,
): string | null {
  const support = REPLAY_SCOPE_SUPPORT[subsystem];
  if (support === SCOPE_NONE) {
    return coverage.kind === "unscoped"
      ? null
      : `${subsystem} has no tenant_id column and no RLS: a scope cannot be applied to it, and accepting one would promise a confinement the table cannot provide`;
  }
  if (support === SCOPE_TENANT_ONLY && coverage.kind !== "tenant") {
    return `${subsystem} requires --tenant or --all-tenants: its tables carry the isolation policy as their only arm, so a ${coverage.kind} read matches zero rows as a non-owner and would print "0 findings" having read nothing`;
  }
  if (support === SCOPE_TENANT_OR_PLATFORM && coverage.kind === "unscoped") {
    return `${subsystem} requires --tenant, --all-tenants or --platform: an unscoped read returns only platform rows as a non-owner (measured: 1 of 7) and every row only as the table's owner, so it is a diagnostic rather than a sweep`;
  }
  return null;
}

/** The subsystems a given scope can serve, so the CLI can report a selection it will skip. */
export function subsystemsServedBy(coverage: ReplayCoverage): readonly ReplaySubsystem[] {
  return REPLAY_SUBSYSTEMS.filter((s) => scopeRefusal(s, coverage) === null);
}

export interface ReplaySubsystemRunner {
  /** Read one subsystem under one scope. Must not write. */
  readonly run: (
    conn: PgConnection,
    coverage: ReplayCoverage,
    limit: number,
  ) => Promise<Omit<ReplaySection, "subsystem" | "coverage">>;
}

/**
 * Runs the selected subsystems under one coverage, refusing per subsystem rather than per
 * invocation.
 *
 * Per subsystem and not per invocation because a mixed selection is the normal case: an operator
 * asking for everything under `--platform` should get the three subsystems that can serve it and a
 * named refusal for the three that cannot, rather than one usage error that tells them to run the
 * command twice without saying which half was fine.
 */
export async function runReplaySections(
  conn: PgConnection,
  coverage: ReplayCoverage,
  selected: readonly ReplaySubsystem[],
  runners: Readonly<Partial<Record<ReplaySubsystem, ReplaySubsystemRunner>>>,
  limit: number,
): Promise<readonly ReplaySection[]> {
  const out: ReplaySection[] = [];
  for (const subsystem of selected) {
    const refusal = scopeRefusal(subsystem, coverage);
    if (refusal !== null) {
      out.push({ subsystem, coverage, complete: false, scanned: 0, refusal, findings: [] });
      continue;
    }
    const runner = runners[subsystem];
    if (runner === undefined) {
      out.push({
        subsystem,
        coverage,
        complete: false,
        scanned: 0,
        refusal: `${subsystem} has no runner wired in this build`,
        findings: [],
      });
      continue;
    }
    try {
      const section = await runner.run(conn, coverage, limit);
      out.push({ subsystem, coverage, ...section });
    } catch (err) {
      // Reported, never thrown: one subsystem's unreadable table must not end a sweep over the
      // other five, and a thrown replay is the shape that made `verifyInstance` able to kill a
      // whole pass on one corrupt row (ADR-0289's rule, applied at the sweep boundary).
      out.push({
        subsystem,
        coverage,
        complete: false,
        scanned: 0,
        refusal: `read failed: ${err instanceof Error ? err.message : String(err)}`,
        findings: [],
      });
    }
  }
  return out;
}

/**
 * A report is `ok` only when every section was **readable** and found nothing.
 *
 * A refused or failed section makes the report not-ok even with zero findings, which is the whole
 * point: `0 findings` from a section that could not be read is the misleading output, and an exit
 * code of 0 would launder it into a passing maintenance job.
 */
export function summarizeReplay(sections: readonly ReplaySection[]): ReplayReport {
  const ok = sections.every((s) => s.refusal === null && s.findings.length === 0);
  return { sections, ok };
}

/** Human rendering. Leads each section with what it could see, then what it found. */
export function formatReplayReport(report: ReplayReport): string {
  const lines: string[] = [];
  for (const s of report.sections) {
    const scope =
      s.coverage.kind === "tenant"
        ? `tenant ${s.coverage.tenantId}`
        : s.coverage.kind === "platform"
          ? "platform"
          : "unscoped";
    if (s.refusal !== null) {
      lines.push(`${s.subsystem} [${scope}]: NOT READ — ${s.refusal}`);
      continue;
    }
    // The window is said before the count, because it is what licenses reading the count as a
    // claim about the subsystem rather than about the page.
    const window = s.complete ? "complete" : `TRUNCATED at ${s.scanned.toString()}`;
    lines.push(
      `${s.subsystem} [${scope}]: ${s.scanned.toString()} examined (${window}), ${s.findings.length.toString()} finding(s)`,
    );
    for (const f of s.findings) lines.push(`  - ${f}`);
  }
  lines.push(
    report.ok
      ? "replay: every selected subsystem was readable and found no drift"
      : "replay: findings above, or a subsystem could not be read — see each section",
  );
  return lines.join("\n");
}
