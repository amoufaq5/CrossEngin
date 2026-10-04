import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

const DEFAULT_SCHEDULER: IntervalScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.(); // don't keep the process alive
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * The actors an unattended deletion runs as. Exported because `cli.ts` checks four-eyes against the
 * *resolved* pair — `--deletion-runner-executed-by system:retention-policy` alone would otherwise pass
 * the flag check and then throw at the runner's construction, i.e. at boot.
 */
export const DEFAULT_DELETION_EXECUTED_BY = "system:deletion-runner";
export const DEFAULT_DELETION_APPROVED_BY = "system:retention-policy";

/** Structural mirror of `DeletionRunner`'s one method, so this file imports no `tenant-lifecycle-pg`. */
export interface DeletionRunnerLike {
  runDue(limit?: number): Promise<
    readonly {
      readonly requestId: string;
      readonly tenantId: string;
      readonly outcome: string;
      readonly tombstoneId: string | null;
      readonly detail: string | null;
    }[]
  >;
}

/** One page of the tombstone sweep (ADR-0327). Structural, so this file imports no store type. */
export interface TombstoneSweepPage {
  readonly examined: number;
  readonly findings: readonly {
    readonly tombstoneId: string;
    readonly tenantId: string;
    readonly reference: string;
    readonly relatedDeletionRequestId: string | null;
    readonly detail: string;
  }[];
  readonly nextAfterTombstoneId: string | null;
}

/**
 * One `auditCompleted` finding (ADR-0323): a *completed* request whose proof no longer stands up.
 *
 * Written out structurally here rather than imported, like `DeletionRunnerLike` above, so this file
 * depends on no `tenant-lifecycle-pg` type. Named `AuditFinding` and not `EvidenceAuditLike` because
 * `deletion-request-routes.ts` already owns that name for the same five fields, and two modules
 * re-exported through `index.ts` cannot both export one name. These are the fields
 * `DeletionEvidenceEscalator.onAuditFinding` reads, so a finding travels from here to the escalator
 * untouched.
 */
export interface AuditFinding {
  readonly requestId: string;
  readonly tenantId: string;
  readonly tombstoneId: string;
  readonly present: boolean;
  readonly detail: string;
}

/**
 * Structural mirror of `DeletionReconciler.reconcileStranded` (ADR-0322). Optional: a deployment with
 * no forensic chain has no tombstone store, so there is no evidence to reconcile from.
 */
export interface StrandedReconcilerLike {
  reconcileStranded(limit?: number): Promise<
    readonly {
      readonly requestId: string;
      readonly tenantId: string;
      readonly verdict: string;
      readonly applied: boolean;
      readonly tombstoneId: string | null;
      readonly tombstoneIds: readonly string[];
      readonly detail: string | null;
    }[]
  >;
  /**
   * The reverse direction (ADR-0323). **Optional on the mirror**, not merely optional to configure:
   * a reconciler that predates it, or a deployment that does not want the pass, leaves the audit
   * section a no-op rather than failing to typecheck or throwing at the first tick.
   */
  auditCompleted?(limit?: number): Promise<readonly AuditFinding[]>;
  /**
   * Every tombstone, whether or not a request names one (ADR-0327). Findings only.
   *
   * Optional for the same reason `auditCompleted` is: the scheduler is wired against a structural
   * mirror, so a store that does not offer it simply does not get swept.
   */
  auditTombstones?(input?: {
    readonly limit?: number;
    readonly afterTombstoneId?: string | null;
  }): Promise<TombstoneSweepPage>;
}

export interface DeletionSchedulerOptions {
  readonly runner: DeletionRunnerLike;
  /**
   * Repairs requests a previous run stranded, in the same tick. One interval and one log line for
   * one queue: a stranded request is the residue of the work this scheduler does, so a separate
   * cadence for it would be two knobs describing one thing.
   */
  readonly reconciler?: StrandedReconcilerLike;
  readonly intervalMs: number;
  /** Requests per tick. Each one is a whole tenant's data, so the default is deliberately small. */
  readonly batchSize?: number;
  readonly scheduler?: IntervalScheduler;
  readonly onError?: (err: unknown) => void;
  readonly onRun?: (results: readonly { readonly requestId: string; readonly outcome: string }[]) => void;
  readonly onReconciled?: (
    results: readonly { readonly requestId: string; readonly verdict: string }[],
  ) => void;
  /**
   * Given **every** result the pass produced, not just the applied ones, and awaited (ADR-0324).
   *
   * Escalation needs the verdicts that were *not* applied — `evidence_unverified` is the whole point
   * — so it cannot share `onReconciled`, whose rule is the opposite: log only what was written. It is
   * idempotent per episode by construction, which is what makes handing it the same finding on every
   * tick harmless.
   */
  readonly onEscalate?: (
    results: readonly {
      readonly requestId: string;
      readonly tenantId: string;
      readonly verdict: string;
      readonly tombstoneId: string | null;
      readonly tombstoneIds: readonly string[];
      readonly detail: string | null;
      /**
       * The verification's defects, carried so the escalator can grade the severity per defect
       * rather than declaring every finding `sev1` (ADR-0326). Optional: a reconciler that does not
       * report them yields the configured default.
       */
      readonly evidence?: { readonly defects: readonly string[] } | null;
    }[],
  ) => void | Promise<void>;
  /**
   * How often the reverse-direction audit runs, as a multiple of ticks. Default 0 = never.
   *
   * **A multiple of the tick rather than every tick, because the two passes do not cost the same.**
   * The forward pass is one indexed query plus a lookup per stranded row, and a stranded request is
   * time-critical — ADR-0321's `completed_unrecorded` leaves a deleted tenant reading `in_progress`.
   * `auditCompleted` re-reads and re-hashes *every* completed request's tombstone (ADR-0323: O(completed
   * requests), capped at 500 by the store), and what it looks for is a tamper on a record that is not
   * going anywhere. At the three-second cadence the live verification used, every tick would re-verify
   * the same rows ~1200 times an hour to find something that is not urgent in minutes.
   *
   * A negative, zero, fractional or non-finite value is **off**, not clamped to 1: a scheduler is
   * configured from a CLI flag, and reading a malformed number as "run the expensive pass every tick"
   * is the wrong direction to fail in.
   */
  readonly auditEveryTicks?: number;
  /**
   * Given the audit's findings, awaited, and **only** when there are some (ADR-0324's escalator is
   * what this feeds). `auditCompleted` already returns findings only — a clean audit is an empty
   * array — so this follows `onReconciled`'s rule rather than `onEscalate`'s: a clean audit is not
   * news. The *recorded* claim that an audit ran clean belongs to the route, which writes an audit row
   * either way (ADR-0313); this callback is for what was found.
   */
  readonly onAuditFindings?: (findings: readonly AuditFinding[]) => void | Promise<void>;
  /**
   * The tombstone sweep's findings (ADR-0327), reported separately because they are a different
   * fact: an `AuditFinding` names a completed *request* whose proof no longer stands up, while these
   * name a *proof* — and the ones that matter most name no request at all, which is exactly why the
   * two could not share a shape.
   */
  readonly onTombstoneFindings?: (page: TombstoneSweepPage) => void | Promise<void>;
  /** Forwarded as-is, so the reconciler's own default governs when it is absent. */
  readonly auditLimit?: number;
}

/**
 * Runs verified GDPR deletion requests out of band, on an interval.
 *
 * Three things it does differently from every sibling scheduler in this app, all deliberate.
 *
 * **It does not sweep on `start()`.** `JobScheduler`, `PruneScheduler` and `DeliveryScheduler` all run
 * once immediately, because a missed prune or a late notification costs nothing. This one waits a full
 * interval: a boot is the moment a misconfiguration is most likely — wrong flags, wrong actor, a
 * manifest that did not load — and the work here irreversibly destroys a tenant's data. An operator who
 * restarts the server to fix something gets an interval's grace, and no deletion is lost by waiting,
 * because the deadline is weeks away.
 *
 * **Two replicas running it is safe, and there is no lock here.** `PostgresDeletionRequestStore.transition`
 * re-asserts `status = 'verified'` inside the `UPDATE`, so of two schedulers claiming the same request
 * exactly one wins and the loser is told `not_claimed`. The row is the lock (ADR-0321).
 *
 * **Not every pass runs on every tick.** The due run and the stranded repair do; the reverse-direction
 * audit of already-completed requests (ADR-0323) runs on a multiple of the tick and is off by default,
 * because it re-hashes every completed request's tombstone to look for a tamper that is not urgent in
 * minutes. One interval with three cadences, rather than a second timer for a queue of the same work.
 */
export class DeletionScheduler {
  private handle: IntervalHandle | null = null;
  /**
   * Ticks elapsed, for the audit's cadence.
   *
   * **On the instance, and deliberately not touched by `start()` or `stop()`.** If it were reset where
   * the interval is installed, a server that restarts its schedulers — a config reload, a crash loop,
   * a `stop(); start()` pair around a manifest swap — would re-enter the audit's countdown from zero
   * every time. Because the test below increments first and then asks for a multiple, a reset is the
   * *safe* direction — it delays the pass rather than repeating it — whereas the opposite test
   * ("the counter is 0, so audit") would have made a restart loop run the expensive pass on every
   * single tick, which is the failure this comment exists to rule out. A fresh process does start at
   * zero, and that is the same grace `start()` already gives the run pass.
   */
  private ticks = 0;
  /**
   * Where the tombstone sweep stopped. Null means "start at the beginning", which is both the
   * initial state and what the end of the table resets it to — so the sweep laps rather than
   * stopping, and a tombstone tampered with after the sweep passed it is found on the next lap.
   */
  private sweepCursor: string | null = null;

  constructor(private readonly opts: DeletionSchedulerOptions) {}

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.scheduler().setInterval(() => void this.runOnce(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  async runOnce(): Promise<void> {
    try {
      const results = await this.opts.runner.runDue(this.opts.batchSize ?? 5);
      if (results.length > 0) this.opts.onRun?.(results);
    } catch (err) {
      // A failed tick must not throw out of the timer. The next one re-reads what is due, and a
      // request this tick claimed but did not finish stays `in_progress` until it is reconciled.
      this.opts.onError?.(err);
    }
    // Separately, and after: a reconciliation pass must still happen on a tick whose `runDue` threw,
    // because the most likely reason a request is stranded is that a run failed.
    try {
      const assessed = (await this.opts.reconciler?.reconcileStranded(this.opts.batchSize ?? 5)) ?? [];
      // Only what was actually written. A `too_recent` or an operator-owned verdict is a standing
      // fact about a row, so reporting it from here would repeat it every single tick for as long as
      // the row exists — that is what `GET /v1/platform/deletion-requests/stranded` is for.
      const repaired = assessed.filter((r) => r.applied);
      if (repaired.length > 0) this.opts.onReconciled?.(repaired);
      // Separately again, and awaited: a finding that warrants an incident must not be lost because
      // the logging callback threw, and escalation is given every result rather than the written ones.
      if (assessed.length > 0) await this.opts.onEscalate?.(assessed);
    } catch (err) {
      this.opts.onError?.(err);
    }
    // Counted before the audit is considered, and counted on every tick whatever the cadence is, so
    // the number means "ticks elapsed" and not "ticks since the last audit".
    this.ticks += 1;
    // A third separate `try`, for the same reason the first two are separate — a throw in one pass must
    // not skip the others — and this is the pass most likely to throw: `auditCompleted` re-parses stored
    // rows, and a row bad enough to fail parsing is itself the finding this pass exists to surface.
    try {
      await this.auditOnce();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  /**
   * The reverse-direction audit (ADR-0323), on its own cadence.
   *
   * The first audit lands on the `auditEveryTicks`-th tick, never on the first: incrementing *before*
   * the modulo is what makes that true, where a counter tested at zero would audit at boot. The run
   * pass declines to sweep at boot because the work is irreversible (ADR-0321); this pass only reads,
   * so the reason is weaker — but a boot is still when a misconfiguration is most likely, and an audit
   * that fires on every restart is noise an operator learns to ignore. Consistency wins.
   */
  private async auditOnce(): Promise<void> {
    const every = this.auditEveryTicks();
    if (every === 0 || this.ticks % every !== 0) return;
    // Its own `try`, so a throwing `auditCompleted` does not take the sweep down with it — and that
    // is not hypothetical: ADR-0323's whole point is that the audit re-parses stored rows and an
    // unparseable row *is* the finding, so the direction most likely to throw was the one sharing a
    // `try` with the sweep. The cursor would never advance either, so the sweep would never run at
    // all while `onError` fired every tick: an audit that looks like it is running. ADR-0322's own
    // precedent is a separate `try` per pass, for the same reason.
    try {
      const findings = (await this.opts.reconciler?.auditCompleted?.(this.opts.auditLimit)) ?? [];
      if (findings.length > 0) await this.opts.onAuditFindings?.(findings);
    } catch (err) {
      this.opts.onError?.(err);
    }
    await this.sweepOnce();
  }

  /**
   * One page of the tombstone sweep per audit tick, resumed from where the last page stopped.
   *
   * Deliberately **one page**, not the whole table: the table only grows and is never pruned, so a
   * full sweep per tick would make the scheduler's cost rise forever and eventually make the tick
   * longer than its interval. A page per tick walks the table at a steady rate and starts over when
   * it reaches the end, which is the right shape for a standing audit — a tampered row is found
   * within one lap rather than immediately, and nothing else finds it at all.
   *
   * Reported even when clean, unlike `auditCompleted` above, because the *examined* count is the
   * claim: "we verified 412 proofs this lap" is what an auditor can use, and ADR-0323's rule is that
   * it cannot be inferred from the absence of a log line.
   */
  private async sweepOnce(): Promise<void> {
    const sweep = this.opts.reconciler?.auditTombstones;
    const reconciler = this.opts.reconciler;
    if (sweep === undefined || reconciler === undefined) return;
    const page = await sweep.call(reconciler, {
      ...(this.opts.auditLimit !== undefined ? { limit: this.opts.auditLimit } : {}),
      ...(this.sweepCursor !== null ? { afterTombstoneId: this.sweepCursor } : {}),
    });
    // Null means the page did not fill, i.e. the end of the table — so the next lap starts over.
    this.sweepCursor = page.nextAfterTombstoneId;
    await this.opts.onTombstoneFindings?.(page);
  }

  private auditEveryTicks(): number {
    const every = this.opts.auditEveryTicks ?? 0;
    return Number.isInteger(every) && every > 0 ? every : 0;
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}
